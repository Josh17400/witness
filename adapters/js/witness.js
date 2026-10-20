// Witness adapter for JavaScript / TypeScript games: browser (plain canvas, Phaser, three.js,
// PixiJS, Babylon.js, ...), Node, Electron and Tauri. One ES module, no dependencies.
// Protocol: docs/PROTOCOL.md in the Witness repo. Integration guide (written for Claude): GUIDE.md.
//
//   import witness from "./witness/witness.js";          // import it FIRST, before the engine
//   ...load assets, build the game...
//   await witness.start({ name: "My Game", fps: 60, size: [1280, 720], canvas,
//                         reset({ seed }) { restartGame(); }, snapshot: () => ({ ... }) });
//
// Modes (decided once, at import):
//   witness  ?witness=host:port in the page URL (browser) or WITNESS_ADDR / --witness (Node).
//            The browser game loop is taken over: requestAnimationFrame callbacks, timers and
//            performance.now / Date.now run on a virtual clock that only advances on `step`.
//            Math.random is seeded; WebGL keeps its drawing buffer; WebAudio is captured offline;
//            input is injected as real DOM events.
//   record   ?witness_record=1|<url> (browser) or WITNESS_RECORD=<file.jsonl> (Node): normal play,
//            written as a replay (docs/PROTOCOL.md section 5).
//   off      everything else. Nothing is patched and every call is a cheap no-op.

const G = globalThis;
const BROWSER = typeof window !== "undefined" && typeof document !== "undefined";
const NODE = typeof process !== "undefined" && !!(process.versions && process.versions.node);
const DEFAULT_ADDR = "127.0.0.1:7357";
const VERSION = "1.0.0";

// The real APIs, captured before any takeover. The adapter only ever uses these.
const real = {
  setTimeout: G.setTimeout.bind(G),
  clearTimeout: G.clearTimeout.bind(G),
  setInterval: G.setInterval.bind(G),
  clearInterval: G.clearInterval.bind(G),
  requestAnimationFrame: typeof G.requestAnimationFrame === "function" ? G.requestAnimationFrame.bind(G) : null,
  cancelAnimationFrame: typeof G.cancelAnimationFrame === "function" ? G.cancelAnimationFrame.bind(G) : null,
  now: G.performance && G.performance.now ? G.performance.now.bind(G.performance) : () => Date.now(),
  Date: G.Date,
  random: Math.random,
  console: G.console ? { log: G.console.log, info: G.console.info, debug: G.console.debug, warn: G.console.warn, error: G.console.error } : null,
};

// ------------------------------------------------------------------ configuration

function readConfig() {
  const c = Object.assign({}, G.WITNESS_CONFIG || {});
  if (BROWSER && G.location) {
    const q = new URLSearchParams(G.location.search);
    if (c.addr == null && q.has("witness")) c.addr = q.get("witness") || DEFAULT_ADDR;
    if (c.record == null && q.has("witness_record")) c.record = q.get("witness_record") || "1";
    if (c.seed == null && q.has("witness_seed")) c.seed = +q.get("witness_seed");
    if (c.audioUnlock == null && q.has("witness_audio_unlock")) c.audioUnlock = q.get("witness_audio_unlock") !== "0";
    for (const k of ["takeover", "raf", "timers", "webaudio", "console"]) {
      if (c[k] == null && q.has(`witness_${k}`)) c[k] = q.get(`witness_${k}`) !== "0";
    }
  }
  if (NODE && process.env) {
    const e = process.env;
    if (c.addr == null && e.WITNESS_ADDR) c.addr = e.WITNESS_ADDR;
    if (c.addr == null && (process.argv || []).includes("--witness")) c.addr = DEFAULT_ADDR;
    if (c.record == null && e.WITNESS_RECORD) c.record = e.WITNESS_RECORD;
    if (c.seed == null && e.WITNESS_SEED) c.seed = +e.WITNESS_SEED;
  }
  return c;
}

const CFG = readConfig();
const MODE = CFG.addr ? "witness" : CFG.record ? "record" : "off";

// ------------------------------------------------------------------ small utilities

const isObj = (v) => v !== null && typeof v === "object";
const errText = (e) => (e && e.stack ? String(e.stack) : String(e));

function b64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  if (NODE && typeof Buffer !== "undefined") return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Make any value JSON-safe: NaN/Infinity become strings, cycles/functions are dropped or named. */
function jsonSafe(v, depth = 0, seen = new Set()) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol") return undefined;
  if (depth > 32) return "[too deep]";
  if (seen.has(v)) return "[circular]";
  if (typeof v.toJSON === "function" && !(v instanceof real.Date)) { try { return jsonSafe(v.toJSON(), depth + 1, seen); } catch { /* fall through */ } }
  if (v instanceof real.Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "Invalid Date";
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (BROWSER && typeof Node !== "undefined" && v instanceof Node) return `<${(v.nodeName || "node").toLowerCase()}>`;
  if (ArrayBuffer.isView(v)) return Array.from(v.length > 4096 ? v.subarray(0, 4096) : v, (x) => jsonSafe(typeof x === "bigint" ? x.toString() : x));
  seen.add(v);
  let out;
  if (Array.isArray(v) || v instanceof Set) {
    out = [];
    for (const x of v) { const s = jsonSafe(x, depth + 1, seen); out.push(s === undefined ? null : s); }
  } else if (v instanceof Map) {
    out = {};
    for (const [k, x] of v) { const s = jsonSafe(x, depth + 1, seen); if (s !== undefined) out[String(k)] = s; }
  } else {
    out = {};
    for (const k of Object.keys(v)) { const s = jsonSafe(v[k], depth + 1, seen); if (s !== undefined) out[k] = s; }
  }
  seen.delete(v);
  return out;
}

/** Keep only the given dotted paths of a state object ("player.pos", "entities"). */
function pickPaths(state, paths) {
  if (!Array.isArray(paths) || !paths.length || !isObj(state)) return state;
  const out = {};
  for (const p of paths) {
    const keys = String(p).split(".").filter(Boolean);
    let src = state, dst = out;
    for (let i = 0; i < keys.length && isObj(src) && keys[i] in src; i++) {
      if (i === keys.length - 1) dst[keys[i]] = src[keys[i]];
      else { dst = dst[keys[i]] = isObj(dst[keys[i]]) ? dst[keys[i]] : Array.isArray(src[keys[i]]) ? [] : {}; src = src[keys[i]]; }
    }
  }
  return out;
}

/** mulberry32, seeded through a splitmix-style scramble so small seeds differ a lot. */
function makeRng(seed) {
  let a = (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normSeed = (s) => {
  if (typeof s === "string") { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
  const n = Math.floor(Number(s));
  return Number.isFinite(n) ? ((n % 4294967296) + 4294967296) % 4294967296 : 1;
};

let currentSeed = CFG.seed != null ? normSeed(CFG.seed) : MODE === "witness" ? 1 : Math.floor(real.random() * 4294967296);
let rng = makeRng(currentSeed);
function reseed(seed) { currentSeed = normSeed(seed); rng = makeRng(currentSeed); }

// Yield to the event loop (all pending promise reactions of the game run before we continue).
const macrotask = (() => {
  if (BROWSER && typeof MessageChannel !== "undefined") {
    const ch = new MessageChannel(), q = [];
    ch.port1.onmessage = () => { const r = q.shift(); if (r) r(); };
    return () => new Promise((r) => { q.push(r); ch.port2.postMessage(0); });
  }
  if (NODE && typeof setImmediate === "function") { const si = setImmediate; return () => new Promise((r) => si(r)); }
  return () => new Promise((r) => real.setTimeout(r, 0));
})();

// ------------------------------------------------------------------ state shared by the modes

const H = {};                       // the game's options/handlers (from start())
const sim = { frame: 0, time: 0 };  // witness frame counter and simulated seconds since reset
let fps = 60;
let started = false;
const logs = [];
const warned = new Set();

function pushLog(level, message) {
  if (MODE !== "witness") return;
  logs.push({ frame: sim.frame, level, message: String(message).slice(0, 8000) });
  if (logs.length > 5000) logs.splice(0, logs.length - 5000);
}
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  pushLog("warn", `[witness] ${message}`);
  if (real.console) real.console.warn.call(G.console, `[witness] ${message}`);
}
function reportError(e, where) {
  pushLog("error", `${where}: ${errText(e)}`);
  if (real.console) real.console.error.call(G.console, `[witness] ${where}:`, e);
}

function formatArgs(args) {
  return args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return errText(a);
    try { const s = JSON.stringify(jsonSafe(a)); return s === undefined ? String(a) : s.length > 600 ? s.slice(0, 600) + "…" : s; }
    catch { return String(a); }
  }).join(" ");
}

function captureConsole() {
  if (!G.console) return;
  const map = { log: "info", info: "info", debug: "info", warn: "warn", error: "error" };
  for (const [name, level] of Object.entries(map)) {
    const orig = real.console[name];
    if (typeof orig !== "function") continue;
    G.console[name] = function (...args) { pushLog(level, formatArgs(args)); return orig.apply(this, args); };
  }
}

function captureErrors() {
  if (BROWSER) {
    G.addEventListener("error", (e) => pushLog("error", e.error ? errText(e.error) : `${e.message} (${e.filename}:${e.lineno})`));
    G.addEventListener("unhandledrejection", (e) => pushLog("error", `unhandled promise rejection: ${errText(e.reason)}`));
  } else if (NODE) {
    process.on("uncaughtException", (e) => reportError(e, "uncaught exception"));
    process.on("unhandledRejection", (e) => reportError(e, "unhandled promise rejection"));
  }
}

// ------------------------------------------------------------------ virtual clock + scheduler (the takeover)
//
// The clock counts 1/1024 ms ticks, so every reading is an exact binary fraction: the difference
// of two readings (what games compute as dt) is exact and identical no matter how long the page
// has been running. That is what makes two runs byte-identical.

const TICK = 1024;
const clock = {
  ticks: Math.round(real.now() * TICK),
  dateBase: 0,
  now() { return this.ticks / TICK; },
  date() { return Math.floor(this.dateBase + this.ticks / TICK); },
  // Rounded DOWN: engines often cap dt at 1000/fps ms (Phaser, many hand-written loops), and a
  // quantized dt just above that cap would be clamped in some frames and not in others.
  dtTicks(sec) { return Math.max(1, Math.floor(sec * 1000 * TICK + 1e-6)); },
  /** Line Date.now() up on a whole millisecond, so its integer steps repeat identically after every reset. */
  align() { const n = this.ticks / TICK; this.dateBase = Math.ceil(this.dateBase + n) - n; },
};
clock.dateBase = (CFG.epoch != null ? +new real.Date(CFG.epoch) : real.Date.UTC(2026, 0, 1)) - clock.now();

const sched = {
  on: false, raf: false, timers: false,
  rafs: new Map(), running: null, rafNext: 1e9 + 1,
  tasks: new Map(), taskNext: 1e9 + 1, seq: 0, nesting: 0,
};

function timerHandle(id) {
  if (!NODE || BROWSER) return id;
  // Node returns Timeout objects; code may call .unref() / .ref() / .refresh() on them.
  const h = { ref: () => h, unref: () => h, hasRef: () => true, refresh: () => { const t = sched.tasks.get(id); if (t) t.due = clock.ticks + Math.round(t.delay * TICK); return h; }, [Symbol.toPrimitive]: () => id };
  return h;
}

function addTask(fn, ms, args, repeat) {
  if (typeof fn !== "function") { const code = String(fn); fn = () => (0, eval)(code); } // eslint-disable-line no-eval
  let delay = Math.max(0, +ms || 0);
  const nest = sched.nesting + 1;
  if (nest > 5 && delay < 4) delay = 4;             // the HTML spec clamp: no zero-delay timer storms
  const id = sched.taskNext++;
  sched.tasks.set(id, { id, fn, args, delay, nest, due: clock.ticks + Math.round(delay * TICK), every: repeat ? Math.max(1, delay) * TICK : 0, seq: sched.seq++ });
  return timerHandle(id);
}
function clearTask(h, realClear) {
  const id = h == null ? h : +h;
  if (sched.tasks.has(id)) sched.tasks.delete(id);
  else if (h != null) realClear(h);                  // a timer created before the takeover
}

function runTasks(target) {
  let budget = 20000;
  for (;;) {
    let next = null;
    for (const t of sched.tasks.values()) if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
    if (!next) break;
    if (--budget < 0) { warnOnce("timer-storm", "more than 20000 timer callbacks in one frame; the rest wait for the next frame"); break; }
    if (next.due > clock.ticks) clock.ticks = next.due;
    if (next.every) { next.due += next.every; next.seq = sched.seq++; } else sched.tasks.delete(next.id);
    sched.nesting = next.nest;
    try { next.fn.apply(G, next.args); } catch (e) { reportError(e, "timer callback"); }
    sched.nesting = 0;
  }
}

function runRafs() {
  if (!sched.rafs.size) return;
  const batch = sched.rafs;
  sched.rafs = new Map();
  sched.running = batch;
  const ts = clock.now();
  for (const [id, cb] of batch) {
    if (!batch.has(id)) continue;                    // cancelled by an earlier callback this frame
    try { cb(ts); } catch (e) { reportError(e, "requestAnimationFrame callback"); }
  }
  sched.running = null;
}

/** One frame of virtual time: timers due within it fire at their own times, then rAF callbacks. */
function runFrame(dt) {
  const target = clock.ticks + clock.dtTicks(dt);
  audioClock.t += dt;
  audioClock.since += dt;   // summed from 0 at every reset: the same run gives the same float sums
  if (sched.timers) runTasks(target);
  clock.ticks = target;
  if (H.step) {
    try { H.step(dt, sim.frame); } catch (e) { reportError(e, "step handler"); }
  }
  if (sched.raf) runRafs();
}

/** A frame driven by real time (before the hello, after a detach, and in record mode). */
function realFrame(dt) {
  const q = clock.dtTicks(dt) / TICK / 1000;   // the quantized dt the clock really advances by
  if (rec.on) recordFrameNow(q, null);
  runFrame(q);
}

function installTakeover({ raf = true, timers = true } = {}) {
  if (sched.on) return;
  sched.on = true;
  const P = G.performance;
  if (P) Object.defineProperty(P, "now", { value: () => clock.now(), configurable: true, writable: true });
  const RealDate = real.Date;
  function WitnessDate(...a) {
    if (!new.target) return new RealDate(clock.date()).toString();
    return Reflect.construct(RealDate, a.length ? a : [clock.date()], new.target);
  }
  WitnessDate.prototype = RealDate.prototype;
  WitnessDate.now = () => clock.date();
  WitnessDate.parse = RealDate.parse;
  WitnessDate.UTC = RealDate.UTC;
  G.Date = WitnessDate;
  if (timers) {
    sched.timers = true;
    G.setTimeout = (fn, ms, ...args) => addTask(fn, ms, args, false);
    G.setInterval = (fn, ms, ...args) => addTask(fn, ms, args, true);
    G.clearTimeout = (h) => clearTask(h, real.clearTimeout);
    G.clearInterval = (h) => clearTask(h, real.clearInterval);
    if (typeof G.requestIdleCallback === "function") {
      G.requestIdleCallback = (cb) => addTask(() => cb({ didTimeout: false, timeRemaining: () => 8 }), 1, [], false);
      G.cancelIdleCallback = (h) => clearTask(h, () => {});
    }
  }
  if (raf && (BROWSER || CFG.raf)) {
    sched.raf = true;
    G.requestAnimationFrame = (cb) => { const id = sched.rafNext++; sched.rafs.set(id, cb); return id; };
    G.cancelAnimationFrame = (id) => { sched.rafs.delete(id); if (sched.running) sched.running.delete(id); };
  }
}

// The real pump drives virtual frames from the real display (rAF) or a real timer: used before
// the hello (so engines can boot and load) and during recorded normal play.
let pump = "none";                 // "real" | "step" | "none"
let pumpHook = null;               // called with dt for every real frame
function startRealPump(hook) {
  pumpHook = hook;
  if (pump === "real") return;
  pump = "real";
  let last = null;
  const tick = (ts) => {
    if (pump !== "real") return;
    const t = ts != null ? ts : real.now();
    const dt = last == null ? 1 / fps : Math.min(Math.max((t - last) / 1000, 0.0001), 0.25);
    last = t;
    try { pumpHook(dt); } catch (e) { reportError(e, "frame"); }
    if (real.requestAnimationFrame && BROWSER) real.requestAnimationFrame(tick); else real.setTimeout(tick, 1000 / fps);
  };
  if (real.requestAnimationFrame && BROWSER) real.requestAnimationFrame(tick); else real.setTimeout(tick, 1000 / fps);
}

// ------------------------------------------------------------------ audio: WebAudio tap + game-side mixer

const sources = [];   // {rate, born (clock ticks), sample(i0, i1) -> Float32Array, prepare?(), render?(ceil)}
// Audio follows simulated time exactly (the sum of the stepped dts), not the quantized clock:
// one step of dt yields dt x sampleRate frames, as the protocol asks.
const audioClock = { t: 0, since: 0 };   // since: simulated seconds since the last reset
let audioMark = 0;
// Sample positions are counted from the last reset (the epoch), never from process start: with 367.5 samples per
// frame (22050 Hz, 60 fps) an absolute count rounds differently depending on how many frames ran before, so the
// same sound would land a sample earlier or later in a later run.
let audioEpoch = 0, audioReadSince = 0;
// (a WebAudio tap anchors its epoch on a 128-frame render quantum instead: see tap.realign)
const epochIndex = (src) => (src.anchor != null ? src.anchor : Math.round((audioEpoch - src.born) * src.rate));

/** A PCM capture buffer that follows simulated time: for games that synthesize their own audio. */
class Mixer {
  constructor({ sampleRate = 22050, channels = 1 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.enabled = MODE === "witness";
    this.buf = new Float32Array(0);
    this.base = 0;              // absolute sample index of buf[0]
    this.born = audioClock.t;
    this.src = { rate: sampleRate, born: this.born, read: 0, sample: (a, b) => this._take(a, b), drop: (a) => this._drop(a), clear: (a) => this._clear(a) };
    this.src.read = Math.round(audioReadSince * sampleRate);   // created mid-run: start reading where the capture is
    this.base = epochIndex(this.src) + this.src.read;
    if (this.enabled) sources.push(this.src);
  }
  /** Mix samples in at the current simulated time (+delay seconds). Stereo input is interleaved. */
  play(samples, { delay = 0, volume = 1 } = {}) {
    if (!this.enabled || !samples) return;
    const mono = this.channels === 2 ? Float32Array.from({ length: samples.length >> 1 }, (_, i) => (samples[2 * i] + samples[2 * i + 1]) / 2) : samples;
    const start = epochIndex(this.src) + Math.round((audioClock.since + delay) * this.sampleRate);
    const end = start + mono.length;
    if (end - this.base > this.buf.length) {
      const grown = new Float32Array(Math.max(end - this.base, this.buf.length * 2));
      grown.set(this.buf);
      this.buf = grown;
    }
    for (let i = Math.max(start, this.base); i < end; i++) this.buf[i - this.base] += mono[i - start] * volume;
  }
  _take(a, b) {
    const out = new Float32Array(Math.max(0, b - a));
    for (let i = Math.max(a, this.base); i < b; i++) { const j = i - this.base; if (j < this.buf.length) out[i - a] = this.buf[j]; }
    return out;
  }
  /** reset: forget everything, including sounds already mixed into the future (they belong to the previous run). */
  _clear(a) {
    this.buf = new Float32Array(0);
    this.base = a;
  }
  _drop(a) {
    const n = Math.min(Math.max(0, a - this.base), this.buf.length);
    if (!n) return;
    this.buf = this.buf.slice(n);
    this.base += n;
  }
}

const TAP_WORKLET = `registerProcessor("witness-tap", class extends AudioWorkletProcessor {
  process(inputs) { const i = inputs[0] && inputs[0][0]; const c = new Float32Array(i ? i.length : 128); if (i) c.set(i);
    this.port.postMessage(c, [c.buffer]); return true; } });`;

// Audio autoplay policy (the CLI's page init script keeps it in globalThis.__witnessWeb; standalone pages use
// WITNESS_CONFIG.audioUnlock / ?witness_audio_unlock=0). "auto": contexts run from the start. "gesture" (like iPhone
// Safari): a context starts suspended and resume() only works while a user gesture is handled: Witness input that is
// one (key down, mouse button, finger lifted) or trusted browser input. While suspended a captured context is silent.
let gestureDepth = 0;
const webReg = () => G.__witnessWeb || null;
const audioGesturePolicy = () => { const w = webReg(); return w ? w.policy === "gesture" : CFG.audioUnlock === false; };
const inGesture = () => { const w = webReg(); return w ? w.inGesture() : gestureDepth > 0; };
const allowResume = () => !audioGesturePolicy() || inGesture();
/** Input that browsers count as a user gesture (HTML "activation-triggering" events; a finger counts when it lifts). */
const activates = (ev) => (ev.type === "key" && ev.down && normKey(ev.key) !== "escape") || (ev.type === "mouse" && typeof ev.down === "boolean")
  || (ev.type === "touch" && ev.phase === "up") || ev.type === "text" || (ev.type === "action" && ev.down);

// currentTime half a sample after the rendered frame N. A sound started at exactly "now" has to be turned back into a
// frame by the engine, and N / rate × rate lands a hair above or below N depending on N (Chrome clamps a start in the
// past to the render quantum's own start time, which has the same problem), so it began on N or N + 1 depending on how
// long the page ran before the reset: the same run gave different audio after some histories (3 in 40 preludes in
// examples/js-browser). Half a sample later, "now" is always a future time half a frame from any rounding edge.
function frameTime(t, rate) {
  const n = Math.round(t * rate);
  if (!(t > 0) || Math.abs(t * rate - n) > 1e-6) return t;
  return (n + 0.5) / rate;
}

/** In witness mode every AudioContext the game creates is an OfflineAudioContext rendered in step with simulated time. */
function installWebAudioTap() {
  const Native = G.OfflineAudioContext;
  if (!Native || !G.AudioWorkletNode) return;
  const nSuspend = Native.prototype.suspend, nResume = Native.prototype.resume;
  const destGet = Object.getOwnPropertyDescriptor(G.BaseAudioContext ? G.BaseAudioContext.prototype : Native.prototype, "destination").get;
  const timeGet = Object.getOwnPropertyDescriptor(G.BaseAudioContext ? G.BaseAudioContext.prototype : Native.prototype, "currentTime").get;
  const seconds = +CFG.audioSeconds || 300;
  function WitnessAudioContext(opts = {}) {
    const rate = (opts && opts.sampleRate) || +CFG.audioRate || 24000;
    const ctx = new Native({ numberOfChannels: 1, length: Math.ceil(rate * seconds), sampleRate: rate });
    const nativeDest = destGet.call(ctx);
    const bus = ctx.createGain();
    Object.defineProperty(bus, "maxChannelCount", { value: 2 });
    const silent = () => ctx.createGain();
    // the autoplay policy, suspend() and close(): while the context isn't running it is FROZEN, as in browsers: it
    // doesn't render, currentTime stays put, and what was scheduled waits (music started while suspended plays from
    // its start after the unlock, as on an iPhone). The capture is silent meanwhile. Two timelines: "output" samples
    // follow simulated time; the context's own samples skip the gaps [[from, to (Infinity while frozen)]] (output).
    const gaps = [];
    const held = !allowResume();   // created outside a gesture under the "gesture" policy: suspended, as in Safari
    const entry = { kind: "captured", resumes: 0, blocked: 0, st: held ? "suspended" : "running", policySuspended: held, waiting: [], sampleRate: rate };
    if (!held && audioGesturePolicy()) entry.unlockedBy = "created in a gesture";
    if (held) gaps.push([0, Infinity]);
    const setState = (st) => {
      if (entry.st === st) return;
      const was = entry.st;
      entry.st = st;
      const at = Math.round(tap.outNow());
      if (was === "running") gaps.push([at, Infinity]);
      else if (st === "running" && gaps.length) gaps[gaps.length - 1][1] = Math.max(gaps[gaps.length - 1][0], at);
      try { ctx.dispatchEvent(new Event("statechange")); } catch { /* no events here */ }
    };
    entry.state = () => entry.st;
    entry.unlock = (by) => {
      if (entry.st === "closed") return;
      entry.policySuspended = false;
      if (!entry.unlockedBy && entry.st !== "running") entry.unlockedBy = by;
      setState("running");
      for (const r of entry.waiting.splice(0)) r();
    };
    if (webReg()) webReg().track(entry);
    Object.defineProperties(ctx, {
      destination: { get: () => bus },
      currentTime: { get: () => frameTime(timeGet.call(ctx), rate) },
      state: { get: () => entry.st },
      resume: { value: () => {
        entry.resumes++;
        if (entry.st === "closed") return Promise.reject(new DOMException("the AudioContext is closed", "InvalidStateError"));
        if (allowResume()) { entry.unlock(inGesture() ? "gesture" : "auto policy"); return Promise.resolve(); }
        entry.blocked++;
        return new Promise((res) => entry.waiting.push(res));   // pending until a gesture unlocks it, as in browsers
      } },
      suspend: { value: () => { if (entry.st !== "closed") { entry.policySuspended = false; setState("suspended"); } return Promise.resolve(); } },
      close: { value: () => { setState("closed"); return Promise.resolve(); } },
      baseLatency: { value: 0 },
      outputLatency: { value: 0 },
      getOutputTimestamp: { value: () => ({ contextTime: ctx.currentTime, performanceTime: clock.now() }) },
      createMediaElementSource: { value: () => { warnOnce("media-element", "createMediaElementSource is not captured in witness mode (use AudioBuffers)"); return silent(); } },
      createMediaStreamSource: { value: () => silent() },
      createMediaStreamDestination: { value: () => Object.assign(silent(), { stream: null }) },
      setSinkId: { value: () => Promise.resolve() },
    });
    const tap = { rate, born: audioClock.t, chunks: [], base: 0, received: 0, rendered: 0, started: false, dead: false, ready: null, frozenBase: 0 };
    // output position of the current simulated time, and output → context samples (the frozen gaps left out)
    tap.outNow = () => (tap.anchor != null ? tap.anchor + audioClock.since * rate : (audioClock.t - tap.born) * rate);
    tap.frozenAt = (o) => { let f = tap.frozenBase; for (const [g0, g1] of gaps) { if (g0 >= o) break; f += Math.min(o, g1) - g0; } return f; };
    tap.ctxAt = (o) => o - tap.frozenAt(o);
    tap.read = Math.round(audioReadSince * rate);   // created mid-run: start reading where the capture is
    tap.prepare = () => {
      if (!tap.ready) {
        tap.ready = (async () => {
          const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
          await ctx.audioWorklet.addModule(url);
          const node = new G.AudioWorkletNode(ctx, "witness-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
          node.port.onmessage = (e) => { tap.chunks.push(e.data); tap.received += e.data.length; };
          bus.connect(node);
          node.connect(nativeDest);
        })();
      }
      return tap.ready;
    };
    // WebAudio renders in 128-frame quanta and ctx.currentTime moves in those steps. A sound a game starts "now"
    // lands on the last quantum boundary, so where the boundaries fall relative to a reset must not depend on how
    // long the process ran before it: every reset anchors the capture on a boundary (tap.anchor), and from there
    // simulated time maps to anchor + since x rate.
    tap.anchor = null;
    tap.render = async (ceil) => {
      if (tap.dead) return;
      const pos = tap.ctxAt(tap.outNow()) / 128;
      await tap.renderTo((ceil ? Math.ceil(pos) : Math.floor(pos)) * 128);
    };
    tap.realign = async () => {
      if (tap.dead) return;
      const o = (audioClock.t - tap.born) * rate;
      const open = gaps.length && gaps[gaps.length - 1][1] === Infinity;
      if (open) { tap.anchor = Math.round(o); return; }   // frozen: nothing renders, the output timeline just goes on
      const target = Math.ceil(tap.ctxAt(o) / 128) * 128;
      await tap.renderTo(target);
      tap.anchor = target + tap.frozenAt(Infinity);
    };
    tap.renderTo = async (target) => {
      if (tap.dead) return;
      try {
        await tap.prepare();
        if (target <= tap.rendered) return;
        if (target >= ctx.length) { tap.dead = true; warnOnce("audio-full", `audio capture is full (${seconds}s per AudioContext; set WITNESS_CONFIG.audioSeconds)`); return; }
        const reached = nSuspend.call(ctx, target / rate);
        if (!tap.started) { tap.started = true; ctx.startRendering().catch(() => {}); } else nResume.call(ctx);
        await reached;
        tap.rendered = target;
      } catch (e) {
        tap.dead = true;
        warnOnce("audio-tap", `WebAudio capture stopped: ${e && e.message}`);
      }
    };
    // output samples [a, b): zeros inside a gap, else the context's samples shifted by the gaps before them
    tap.sample = (a, b) => {
      const out = new Float32Array(Math.max(0, b - a));
      const copy = (c0, c1, dst) => {
        let off = tap.base;
        for (const c of tap.chunks) {
          const lo = Math.max(c0, off), hi = Math.min(c1, off + c.length);
          for (let i = lo; i < hi; i++) out[dst + i - c0] = c[i - off];
          off += c.length;
          if (off >= c1) break;
        }
      };
      for (let i = a; i < b;) {
        let f = tap.frozenBase, inGap = null, next = Infinity;
        for (const [g0, g1] of gaps) { if (g1 <= i) f += g1 - g0; else if (g0 <= i) { inGap = g1; break; } else { next = g0; break; } }
        const e = Math.min(b, inGap != null ? inGap : next);
        if (inGap == null) copy(i - f, e - f, i - a);
        i = e;
      }
      return out;
    };
    tap.drop = (a) => {
      const c = tap.ctxAt(a);
      while (gaps.length && gaps[0][1] <= a) { const [g0, g1] = gaps.shift(); tap.frozenBase += g1 - g0; }
      while (tap.chunks.length && tap.base + tap.chunks[0].length <= c) tap.base += tap.chunks.shift().length;
    };
    tap.settle = async () => {   // worklet messages arrive asynchronously: wait until they caught up
      const end = real.now() + 2000;
      while (!tap.dead && tap.received < tap.rendered && real.now() < end) await new Promise((r) => real.setTimeout(r, 2));
    };
    sources.push(tap);
    return ctx;
  }
  WitnessAudioContext.prototype = Native.prototype;
  G.AudioContext = WitnessAudioContext;
  if (G.webkitAudioContext) G.webkitAudioContext = WitnessAudioContext;
}

async function renderAudio(ceil) {
  for (const s of sources) if (s.render) await s.render(ceil);
}

async function readAudio() {
  await renderAudio(true);
  for (const s of sources) if (s.settle) await s.settle();
  const rate = sources.length ? sources[0].rate : 22050;
  const t1 = audioClock.t;
  // every read covers [what was read before, all of the time since the epoch): consecutive replies tile exactly
  const total = (r) => Math.max(0, Math.round(audioClock.since * r));
  const n = Math.max(0, total(rate) - (sources.length ? sources[0].read || 0 : 0));
  const out = new Float32Array(n);
  for (const s of sources) {
    const a = epochIndex(s) + (s.read || 0), b = epochIndex(s) + total(s.rate);
    s.read = total(s.rate);
    const pcm = s.sample(a, b);
    if (pcm.length === n) for (let i = 0; i < n; i++) out[i] += pcm[i];
    else for (let i = 0; i < n && pcm.length; i++) out[i] += pcm[Math.min(pcm.length - 1, Math.floor((i * pcm.length) / n))];
    s.drop(b);
  }
  audioMark = t1;
  audioReadSince = audioClock.since;
  return { sampleRate: rate, channels: 1, format: "f32", data: b64(new Uint8Array(out.buffer)) };
}

// ------------------------------------------------------------------ input

const KEYS = (() => {
  const k = {
    space: [" ", "Space", 32], enter: ["Enter", "Enter", 13], escape: ["Escape", "Escape", 27], tab: ["Tab", "Tab", 9],
    backspace: ["Backspace", "Backspace", 8], shift: ["Shift", "ShiftLeft", 16], ctrl: ["Control", "ControlLeft", 17],
    alt: ["Alt", "AltLeft", 18], meta: ["Meta", "MetaLeft", 91], left: ["ArrowLeft", "ArrowLeft", 37], up: ["ArrowUp", "ArrowUp", 38],
    right: ["ArrowRight", "ArrowRight", 39], down: ["ArrowDown", "ArrowDown", 40], delete: ["Delete", "Delete", 46],
    insert: ["Insert", "Insert", 45], home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33],
    pagedown: ["PageDown", "PageDown", 34], capslock: ["CapsLock", "CapsLock", 20], minus: ["-", "Minus", 189],
    equal: ["=", "Equal", 187], comma: [",", "Comma", 188], period: [".", "Period", 190], slash: ["/", "Slash", 191],
    semicolon: [";", "Semicolon", 186], quote: ["'", "Quote", 222], bracketleft: ["[", "BracketLeft", 219],
    bracketright: ["]", "BracketRight", 221], backslash: ["\\", "Backslash", 220], backquote: ["`", "Backquote", 192],
  };
  for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); k[c] = [c, `Key${c.toUpperCase()}`, 65 + i]; }
  for (let i = 0; i < 10; i++) k[String(i)] = [String(i), `Digit${i}`, 48 + i];
  for (let i = 1; i <= 12; i++) k[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];
  return k;
})();
const KEY_ALIASES = { esc: "escape", return: "enter", control: "ctrl", option: "alt", cmd: "meta", command: "meta", super: "meta", win: "meta", windows: "meta", " ": "space", arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", ";": "semicolon", "'": "quote", "[": "bracketleft", "]": "bracketright", "\\": "backslash", "`": "backquote", del: "delete", pgup: "pageup", pgdn: "pagedown" };
const normKey = (name) => { const n = String(name).toLowerCase(); return KEY_ALIASES[n] || n; };
// DOM KeyboardEvent -> Witness key name (used by the recorder)
const CODE_TO_NAME = (() => { const m = {}; for (const [n, [, code]] of Object.entries(KEYS)) m[code] = n; Object.assign(m, { ShiftRight: "shift", ControlRight: "ctrl", AltRight: "alt", MetaRight: "meta", NumpadEnter: "enter" }); return m; })();
const domKeyName = (e) => CODE_TO_NAME[e.code] || (/^Numpad\d$/.test(e.code) ? e.code.slice(6) : normKey(e.key || e.code || "unidentified"));

const PAD_BUTTONS = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15, home: 16 };
const PAD_ALIASES = { cross: "a", circle: "b", square: "x", triangle: "y", l1: "lb", r1: "rb", l2: "lt", r2: "rt", select: "back", options: "start", guide: "home", l3: "ls", r3: "rs", dpup: "up", dpdown: "down", dpleft: "left", dpright: "right", leftshoulder: "lb", rightshoulder: "rb" };
const PAD_AXES = { leftx: 0, lefty: 1, rightx: 2, righty: 3 };

// Touch: finger ids are small integers (0 = first finger down). Injected touch pointers get
// pointerId TOUCH_POINTER_ID + id, so they never collide with the mouse (pointerId 1).
const TOUCH_POINTER_ID = 100;
// "cancel" = the system ended the touch (touchcancel / pointercancel): it ends the finger like "up".
const touchPhase = (p) => (p === "down" || p === "up" || p === "cancel" ? p : "move");
const touchEnds = (p) => p === "up" || p === "cancel";
const touchId = (id) => (Number.isFinite(+id) ? Math.trunc(+id) : 0);
/** An incoming touch event with defaults filled in: id 0, phase "move" when missing/unknown, pressure 1. */
const normTouch = (e) => ({ ...e, id: touchId(e.id), x: +e.x || 0, y: +e.y || 0, phase: touchPhase(e.phase), pressure: e.pressure != null && Number.isFinite(+e.pressure) ? +e.pressure : 1 });
/** The replay shape of a touch: {type, id, x, y, phase} (+ pressure only when it says something: 0 < p < 1 or > 1). */
function touchShape(e) {
  const o = { type: "touch", id: touchId(e.id), x: +e.x || 0, y: +e.y || 0, phase: touchPhase(e.phase) };
  if (+e.pressure > 0 && +e.pressure !== 1) o.pressure = +e.pressure;
  return o;
}
/** The mouse fallback for finger 0: down -> button 0 down, move -> move, up/cancel -> button 0 up (flagged fromTouch). */
function touchMouse(t) {
  const m = { frame: t.frame, type: "mouse", x: t.x, y: t.y, fromTouch: true };
  if (t.phase !== "move") { m.button = 0; m.down = t.phase === "down"; }
  return m;
}

/** What Witness has injected so far: handy for Node games that poll instead of listening. */
const inputState = { keys: new Set(), mouse: { x: 0, y: 0, buttons: 0 }, touches: new Map(), pad: { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] }, actions: new Set() };
let queue = [];            // pending protocol events, sorted by frame
let frameEvents = [];      // events applied at the current frame (witness.inputEvents())

function queueInput(events) {
  for (const e of events || []) if (isObj(e)) queue.push(e.type === "touch" ? normTouch(e) : e);
  queue.sort((a, b) => (a.frame | 0) - (b.frame | 0));   // stable: same-frame events keep their order
}

function applyInputs(frame) {
  frameEvents = [];
  let n = 0;
  while (n < queue.length && (queue[n].frame | 0) <= frame) n++;
  if (!n) return;
  for (const ev of queue.splice(0, n)) {
    const compat = deliver(ev);
    // Mouse fallback: finger 0 is also the mouse, right after its touch event, unless the game
    // handles touch itself (start({touch: true})) or cancelled the touch (preventDefault, browsers).
    if (ev.type === "touch" && ev.id === 0 && !H.touch && compat) deliver(touchMouse(ev));
  }
}

/** One event: the game's input(ev) handler first, else (browsers) real DOM events. Returns false
 *  only for a touch the page cancelled, so no compatibility mouse event follows it. */
function deliver(ev) {
  const g = activates(ev);   // a user gesture while it is delivered: what lets the game's handler resume audio
  if (!g) return deliverNow(ev);
  gestureDepth++;
  const w = webReg();
  if (w) w.begin();
  try { return deliverNow(ev); } finally { gestureDepth--; if (w) w.end(); }
}
function deliverNow(ev) {
  frameEvents.push(ev);
  track(ev);
  let handled = false;
  if (H.input) { try { handled = H.input(ev) === true; } catch (e) { reportError(e, "input handler"); } }
  if (!handled && BROWSER) { try { return dom.inject(ev) !== false; } catch (e) { reportError(e, `injecting ${ev.type}`); } }
  return true;
}

function track(ev) {
  const s = inputState;
  if (ev.type === "key") { const k = normKey(ev.key); if (ev.down) s.keys.add(k); else s.keys.delete(k); }
  else if (ev.type === "mouse") {
    if (ev.x != null) { s.mouse.x = +ev.x; s.mouse.y = +ev.y; }
    if (typeof ev.down === "boolean") { const m = [1, 4, 2][ev.button | 0] || 1; s.mouse.buttons = ev.down ? s.mouse.buttons | m : s.mouse.buttons & ~m; }
  } else if (ev.type === "touch") {
    if (touchEnds(ev.phase)) s.touches.delete(ev.id);
    else s.touches.set(ev.id, { x: ev.x, y: ev.y, pressure: ev.pressure });
  } else if (ev.type === "action") { if (ev.down) s.actions.add(ev.action); else s.actions.delete(ev.action); }
  else if (ev.type === "pad") { const i = PAD_BUTTONS[PAD_ALIASES[ev.button] || ev.button]; if (i != null) s.pad.buttons[i] = ev.down ? 1 : 0; }
  else if (ev.type === "axis") {
    const i = PAD_AXES[ev.axis];
    if (i != null) s.pad.axes[i] = +ev.value || 0;
    else if (ev.axis === "lefttrigger" || ev.axis === "righttrigger") s.pad.buttons[ev.axis === "lefttrigger" ? 6 : 7] = +ev.value || 0;
  }
}

// Browser injection: real DOM events through the game's normal input path.
const dom = {
  pressTarget: null, suppressCompat: false, padUsed: false, lastClient: null, touchPress: false,
  canvases() {
    const c = typeof H.canvas === "function" ? H.canvas() : typeof H.canvas === "string" ? document.querySelectorAll(H.canvas) : H.canvas;
    if (c) return (c instanceof Element ? [c] : Array.from(c)).filter(Boolean);
    let best = null, area = -1;
    for (const cv of document.querySelectorAll("canvas")) { const a = cv.width * cv.height; if (a > area) { best = cv; area = a; } }
    return best ? [best] : [];
  },
  logicalSize() {
    if (Array.isArray(H.size)) return H.size;
    const c = this.canvases()[0];
    return c ? [c.width, c.height] : [G.innerWidth, G.innerHeight];
  },
  toClient(x, y) {
    const c = this.canvases()[0];
    if (!c) return [x, y];
    const r = c.getBoundingClientRect(), [w, h] = this.logicalSize();
    return [r.left + (x * r.width) / w, r.top + (y * r.height) / h];
  },
  toLogical(cx, cy) {
    const c = this.canvases()[0];
    if (!c) return [cx, cy];
    const r = c.getBoundingClientRect(), [w, h] = this.logicalSize();
    return [Math.round(((cx - r.left) * w * 100) / (r.width || 1)) / 100, Math.round(((cy - r.top) * h * 100) / (r.height || 1)) / 100];
  },
  keyTarget() {
    if (H.keyTarget) return typeof H.keyTarget === "function" ? H.keyTarget() : H.keyTarget;
    const c = this.canvases()[0];
    if (c && c.hasAttribute("tabindex")) return c;
    const a = document.activeElement;
    return a && a !== document.documentElement ? a : document.body || document;
  },
  mods() { const k = inputState.keys; return { shiftKey: k.has("shift"), ctrlKey: k.has("ctrl"), altKey: k.has("alt"), metaKey: k.has("meta") }; },
  key(type, name, keyOverride) {
    const def = KEYS[name] || [name.length === 1 ? name : name.charAt(0).toUpperCase() + name.slice(1), name.length === 1 ? "" : name, 0];
    let key = keyOverride || def[0];
    if (!keyOverride && key.length === 1 && inputState.keys.has("shift")) key = key.toUpperCase();
    const code = def[1], keyCode = def[2];
    const location = /(Shift|Control|Alt|Meta)Left/.test(code) ? 1 : /Right$/.test(code) && /(Shift|Control|Alt|Meta)/.test(code) ? 2 : 0;
    const charCode = type === "keypress" ? key.charCodeAt(0) : 0;
    const ev = new KeyboardEvent(type, { key, code, location, keyCode: type === "keypress" ? charCode : keyCode, which: type === "keypress" ? charCode : keyCode, charCode, repeat: false, bubbles: true, cancelable: true, composed: true, view: G, ...this.mods() });
    const legacy = type === "keypress" ? charCode : keyCode;
    if (ev.keyCode !== legacy) Object.defineProperty(ev, "keyCode", { get: () => legacy });
    if (ev.which !== legacy) Object.defineProperty(ev, "which", { get: () => legacy });
    return this.keyTarget().dispatchEvent(ev);
  },
  /** fromTouch: the compatibility mouse events of finger 0 (mouse* + click only; the touch already
   *  dispatched its own pointer events, as in a real browser). */
  pointer(kind, x, y, button, fromTouch = false) {
    const [cx, cy] = this.toClient(x, y);
    const under = document.elementFromPoint(cx, cy) || this.canvases()[0] || document.body;
    const target = kind !== "down" && this.pressTarget ? this.pressTarget : under;
    const buttons = inputState.mouse.buttons;
    const [mx, my] = this.lastClient ? [cx - this.lastClient[0], cy - this.lastClient[1]] : [0, 0];
    this.lastClient = [cx, cy];
    const init = { bubbles: true, cancelable: true, composed: true, view: G, clientX: cx, clientY: cy, screenX: cx, screenY: cy, movementX: mx, movementY: my, button: kind === "move" ? -1 : button, buttons, ...this.mods() };
    const pInit = fromTouch
      ? { ...init, pointerId: TOUCH_POINTER_ID, pointerType: "touch", isPrimary: true, width: 1, height: 1, pressure: buttons ? 1 : 0 }
      : { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0 };
    const ok = G.PointerEvent && !fromTouch ? target.dispatchEvent(new PointerEvent(`pointer${kind}`, pInit)) : true;
    if (kind === "down" && !ok) this.suppressCompat = true;
    if (!this.suppressCompat) target.dispatchEvent(new MouseEvent(`mouse${kind}`, { ...init, button: kind === "move" ? 0 : button }));
    if (kind === "down") this.pressTarget = target;
    if (kind === "down" && button === 0) this.touchPress = fromTouch;   // so a reset releases it the same way
    if (kind === "up") {
      const pressed = this.pressTarget;
      if (!buttons) { this.pressTarget = null; this.suppressCompat = false; }
      if (pressed && (pressed === under || pressed.contains(under))) {
        if (button === 0) target.dispatchEvent(new (G.PointerEvent || MouseEvent)("click", { ...pInit, button: 0 }));
        else if (button === 1) target.dispatchEvent(new (G.PointerEvent || MouseEvent)("auxclick", { ...pInit, button: 1 }));
      }
      if (button === 2) under.dispatchEvent(new MouseEvent("contextmenu", { ...init, button: 2 }));
    }
  },
  last: [0, 0],
  fingers: new Map(),   // finger id -> {id, target, x, y, cx, cy, force, compat} while it is down
  touchList(list) {
    try {
      return list.map((t) => new Touch({ identifier: t.id, target: t.target, clientX: t.cx, clientY: t.cy, screenX: t.cx, screenY: t.cy,
        pageX: t.cx + (G.scrollX || 0), pageY: t.cy + (G.scrollY || 0), radiusX: 0.5, radiusY: 0.5, rotationAngle: 0, force: t.force }));
    } catch { return null; }
  },
  /** A touch as real DOM events: pointer events (pointerType "touch") then TouchEvents (touchstart /
   *  touchmove / touchend / touchcancel, with touches / targetTouches / changedTouches across all fingers). Every
   *  event of a finger goes to the element it went down on (implicit capture, like real touch).
   *  Returns false when the page cancelled it (preventDefault on pointerdown/touchstart for the whole
   *  touch, on touchmove for that move), so no compatibility mouse event follows. */
  finger(ev) {
    const { id, phase } = ev, x = ev.x, y = ev.y, ends = touchEnds(phase), cancel = phase === "cancel";
    const [cx, cy] = this.toClient(x, y);
    const under = document.elementFromPoint(cx, cy) || this.canvases()[0] || document.body;
    let t = this.fingers.get(id);
    if (phase === "down" || !t) {
      t = { id, target: under, compat: true };
      if (!ends) this.fingers.set(id, t);   // a move without a down: a finger that came from off-canvas
    }
    Object.assign(t, { x, y, cx, cy, force: ends ? 0 : ev.pressure });
    if (ends) this.fingers.delete(id);
    const target = t.target;
    const base = { bubbles: true, cancelable: true, composed: true, view: G, ...this.mods() };
    let pointerOk = true, touchOk = true;
    if (G.PointerEvent) {
      const p = { ...base, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pointerId: TOUCH_POINTER_ID + id, pointerType: "touch",
        isPrimary: id === 0, width: 1, height: 1, pressure: ends ? 0 : ev.pressure, button: phase === "move" || cancel ? -1 : 0, buttons: ends ? 0 : 1 };
      const send = (type, extra) => target.dispatchEvent(new PointerEvent(type, extra ? { ...p, ...extra } : p));
      if (phase === "down") { send("pointerover"); send("pointerenter", { bubbles: false, cancelable: false }); }
      pointerOk = send(`pointer${phase}`, cancel ? { cancelable: false } : undefined);   // pointercancel can't be cancelled
      if (ends) { send("pointerout"); send("pointerleave", { bubbles: false, cancelable: false }); }
    }
    if (typeof G.TouchEvent === "function" && typeof G.Touch === "function") {
      const all = [...this.fingers.values()];
      const changed = this.touchList([t]), touches = this.touchList(all), targetTouches = this.touchList(all.filter((o) => o.target === target));
      if (changed && touches && targetTouches) {
        try {
          touchOk = target.dispatchEvent(new TouchEvent(phase === "down" ? "touchstart" : phase === "up" ? "touchend" : cancel ? "touchcancel" : "touchmove", { ...base, ...(cancel ? { cancelable: false } : {}), touches, targetTouches, changedTouches: changed }));
        } catch (e) { warnOnce("touch-event", `TouchEvent could not be created here (${e && e.message}); only pointer events were sent`); }
      }
    }
    if (phase === "down") { if (!pointerOk || !touchOk) t.compat = false; return t.compat; }
    if (phase === "move") return t.compat && touchOk;
    return t.compat;   // up / cancel: the mouse button that went down is always released
  },
  inject(ev) {
    switch (ev.type) {
      case "key": {
        const name = normKey(ev.key);
        if (ev.down) { const ok = this.key("keydown", name); const k = (KEYS[name] || [name])[0]; if (ok && k.length === 1) this.key("keypress", name); }
        else this.key("keyup", name);
        break;
      }
      case "mouse": {
        const x = ev.x != null ? +ev.x : this.last[0], y = ev.y != null ? +ev.y : this.last[1];
        const moved = x !== this.last[0] || y !== this.last[1];
        const fromTouch = ev.fromTouch === true;
        this.last = [x, y];
        if (typeof ev.down !== "boolean") { this.pointer("move", x, y, 0, fromTouch); break; }
        if (moved) {
          // the move happens before the press/release, so it carries the previous button mask
          const now = inputState.mouse.buttons, m = [1, 4, 2][ev.button | 0] || 1;
          inputState.mouse.buttons = ev.down ? now & ~m : now | m;
          this.pointer("move", x, y, 0, fromTouch);
          inputState.mouse.buttons = now;
        }
        this.pointer(ev.down ? "down" : "up", x, y, ev.button | 0, fromTouch);
        break;
      }
      case "touch":
        return this.finger(ev);
      case "wheel": {
        const [cx, cy] = this.toClient(this.last[0], this.last[1]);
        const t = document.elementFromPoint(cx, cy) || this.canvases()[0] || document.body;
        t.dispatchEvent(new WheelEvent("wheel", { deltaX: +ev.dx || 0, deltaY: +ev.dy || 0, deltaMode: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true, composed: true, view: G, ...this.mods() }));
        break;
      }
      case "text": {
        for (const ch of String(ev.text || "")) {
          const name = KEYS[normKey(ch)] ? normKey(ch) : ch;
          if (this.key("keydown", name, ch)) {
            this.key("keypress", name, ch);
            const t = this.keyTarget();
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
              t.setRangeText(ch, t.selectionStart ?? t.value.length, t.selectionEnd ?? t.value.length, "end");
              t.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
            }
          }
          this.key("keyup", name, ch);
        }
        break;
      }
      case "action":
        if (H.action) H.action(ev.action, !!ev.down);
        else this.inject({ type: "key", key: ev.action, down: ev.down });
        break;
      case "pad": case "axis":
        if (!this.padUsed) {
          this.padUsed = true;
          const e = new Event("gamepadconnected");
          Object.defineProperty(e, "gamepad", { value: virtualPad() });
          G.dispatchEvent(e);
        }
        break;
      default:
        warnOnce(`input-${ev.type}`, `input type '${ev.type}' is not understood by the JS adapter (pass input(ev) to witness.start to handle it)`);
    }
  },
  releaseAll() {
    for (const t of [...this.fingers.values()]) this.finger({ id: t.id, x: t.x, y: t.y, phase: "up", pressure: 0 });
    for (const k of [...inputState.keys]) { inputState.keys.delete(k); this.key("keyup", k); }
    for (const [mask, button] of [[1, 0], [4, 1], [2, 2]]) {
      if (inputState.mouse.buttons & mask) { inputState.mouse.buttons &= ~mask; this.pointer("up", this.last[0], this.last[1], button, button === 0 && this.touchPress); }
    }
  },
};

function virtualPad() {
  const p = inputState.pad;
  return {
    id: "Witness virtual gamepad (STANDARD GAMEPAD)", index: 0, connected: true, mapping: "standard", timestamp: clock.now(),
    axes: p.axes.slice(), buttons: p.buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })), vibrationActuator: null, hapticActuators: [],
  };
}

function installVirtualGamepad() {
  const nav = G.navigator;
  if (!nav) return;
  const orig = typeof nav.getGamepads === "function" ? nav.getGamepads.bind(nav) : () => [];
  Object.defineProperty(nav, "getGamepads", { configurable: true, value: () => (dom.padUsed ? [virtualPad(), null, null, null] : orig()) });
}

function releaseAllInput() {
  queue = [];
  if (BROWSER && MODE === "witness") { try { dom.releaseAll(); } catch (e) { reportError(e, "releasing input"); } }
  inputState.keys.clear();
  inputState.actions.clear();
  inputState.mouse.buttons = 0;
  inputState.touches.clear();
  inputState.pad.buttons.fill(0);
  inputState.pad.axes.fill(0);
}

// ------------------------------------------------------------------ screenshots

const contextKind = new WeakMap();

/** Every WebGL context keeps its drawing buffer in witness mode, so it can be read back at any time. */
function patchCanvasContexts() {
  if (!G.HTMLCanvasElement) return;
  const proto = G.HTMLCanvasElement.prototype, orig = proto.getContext;
  proto.getContext = function (type, attrs) {
    if (/^(webgl2?|experimental-webgl)$/.test(type)) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    // 2D: rasterize on the CPU from the first frame. Browsers move a canvas from GPU to CPU raster after a few
    // readbacks (screenshots), and the two anti-alias edges differently, so later shots would differ by a few px.
    if (type === "2d") attrs = Object.assign({}, attrs, { willReadFrequently: true });
    const ctx = orig.call(this, type, attrs);
    if (ctx && !contextKind.has(this)) contextKind.set(this, type);
    return ctx;
  };
}

async function screenshot(scale = 1) {
  if (H.screenshot) {
    const r = await H.screenshot({ scale });
    if (BROWSER && r && (r instanceof Element || (G.OffscreenCanvas && r instanceof G.OffscreenCanvas))) return grab([r], scale);
    if (r && r.data && typeof r.data !== "string") return { ...r, format: r.format || "rgba8", data: b64(r.data) };
    return r;
  }
  if (!BROWSER) throw new Error("no screenshot handler: pass screenshot() to witness.start");
  return grab(dom.canvases(), scale);
}

function grab(list, scale) {
  if (!list.length) throw new Error("no <canvas> found: pass canvas to witness.start");
  const base = list[0];
  const w = Math.max(1, Math.round(base.width * scale)), h = Math.max(1, Math.round(base.height * scale));
  const png = H.screenshotFormat === "png";
  let c2;
  if (list.length === 1 && scale === 1 && contextKind.get(base) === "2d" && !png) c2 = base.getContext("2d");
  else {
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    c2 = off.getContext("2d", { willReadFrequently: true });
    c2.imageSmoothingEnabled = scale < 1;
    for (const cv of list) c2.drawImage(cv, 0, 0, w, h);
  }
  if (png) return { width: w, height: h, format: "png", data: c2.canvas.toDataURL("image/png").split(",")[1] };
  return { width: w, height: h, format: "rgba8", data: b64(c2.getImageData(0, 0, w, h).data) };
}

// ------------------------------------------------------------------ recording (normal play)

const rec = { on: false, frame: 0, pending: [], lines: [], sink: null, header: null, mark: null };

function recordLine(obj) { rec.lines.push(JSON.stringify(obj)); if (rec.sink && rec.lines.length >= 120) rec.sink.flush(); }

function beginRecording() {
  rec.on = true;
  rec.frame = 0;
  rec.header = { replay: 1, name: H.name || "game", seed: currentSeed, fps, started: new real.Date().toISOString() };
  recordLine(rec.header);
}

function recordFrameNow(dt, events) {
  if (!rec.on) return dt;
  const line = { f: rec.frame++, dt };
  // mouse events synthesized from a touch are never recorded (replay recreates them from the touch)
  const evs = rec.pending.concat(events || [])
    .filter((e) => !(isObj(e) && e.type === "mouse" && e.fromTouch))
    .map((e) => (isObj(e) && e.type === "touch" ? touchShape(e) : e));
  rec.pending = [];
  if (evs.length) line.in = evs;
  if (rec.mark) { line.mark = rec.mark; rec.mark = null; }
  recordLine(line);
  return dt;
}

async function nodeRecordSink(file) {
  const fs = await import(/* @vite-ignore */ /* webpackIgnore: true */ "node:" + "fs");
  const dir = String(file).replace(/[\\/][^\\/]*$/, "");
  if (dir && dir !== file) fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(file, "w");
  const flush = () => { if (rec.lines.length) { fs.writeSync(fd, rec.lines.join("\n") + "\n"); rec.lines = []; } };
  // <file>.state.json: the state play ended in, which `witness replay` checks the replay ends in exactly (a clean
  // exit or Ctrl+C only, not a crash; a synchronous snapshot handler only: 'exit' can't await)
  const endState = (code) => {
    if ((code !== 0 && code !== 130) || !H.snapshot) return;
    try {
      const st = H.snapshot();
      if (st && typeof st.then === "function") return;
      fs.writeFileSync(`${file}.state.json`, JSON.stringify({ frame: rec.frame, state: jsonSafe(st) }));
    } catch (e) { process.stderr.write(`[witness] no end state for the replay: ${e && e.message}\n`); }
  };
  process.on("exit", (code) => { flush(); endState(code); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { flush(); process.exit(130); });
  return { flush };
}

function browserRecordSink(target) {
  const session = new real.Date().toISOString().replace(/[:.]/g, "-");
  if (target === "1" || target === "true" || target === "download") {
    // Download mode: F9 (or witness.saveRecording()) downloads everything recorded so far.
    const all = [];
    return {
      flush() { all.push(...rec.lines); rec.lines = []; },
      save() {
        this.flush();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([all.join("\n") + "\n"], { type: "application/x-ndjson" }));
        a.download = `replay-${session}.jsonl`;
        document.body.appendChild(a); a.click(); a.remove();
        return a.download;
      },
    };
  }
  // Endpoint mode: POST chunks of lines to a dev-server URL (session id in the query string).
  const url = `${target}${target.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
  const sink = {
    flush(beacon = false) {
      if (!rec.lines.length) return;
      const body = rec.lines.join("\n") + "\n";
      rec.lines = [];
      if (beacon && G.navigator && G.navigator.sendBeacon) G.navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
      else G.fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "application/x-ndjson" } }).catch((e) => real.console && real.console.warn.call(G.console, "[witness] couldn't post the replay:", e.message));
    },
    save() { this.flush(); return url; },
  };
  real.setInterval(() => sink.flush(), 1000);
  G.addEventListener("pagehide", () => sink.flush(true));
  G.document.addEventListener("visibilitychange", () => { if (G.document.visibilityState === "hidden") sink.flush(true); });
  return sink;
}

/** Record real DOM input (capture phase, before the game sees it) for the next frame line. */
function installRecorderListeners() {
  const opt = { capture: true, passive: true };
  const push = (ev) => { if (rec.on) rec.pending.push(ev); };
  G.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.repeat) return;
    const k = domKeyName(e);
    if (k === "f8") { rec.mark = "F8"; return; }
    if (k === "f9" && rec.sink && rec.sink.save) { const where = rec.sink.save(); if (real.console) real.console.info.call(G.console, `[witness] replay saved: ${where}`); return; }
    push({ type: "key", key: k, down: true });
  }, opt);
  G.addEventListener("keyup", (e) => { const k = domKeyName(e); if (e.isTrusted && k !== "f8" && k !== "f9") push({ type: "key", key: k, down: false }); }, opt);
  const mouse = (e, down) => {
    if (!e.isTrusted) return;
    const [x, y] = dom.toLogical(e.clientX, e.clientY);
    const ev = { type: "mouse", x, y };
    if (down !== undefined) { ev.button = e.button; ev.down = down; }
    const last = rec.pending[rec.pending.length - 1];
    if (down === undefined && last && last.type === "mouse" && last.down === undefined) rec.pending[rec.pending.length - 1] = ev;
    else push(ev);
  };
  // Touch pointers are recorded as touch events with small finger ids (0 = first finger down,
  // reused after it lifts). The compatibility mouse events browsers fire after a touch are mouse*
  // events, not pointer events, so they are never recorded (replay's mouse fallback recreates them).
  const slots = new Map();   // pointerId -> {id: finger id, x, y: its last position}
  const touch = (e, phase, cancel = false) => {
    if (!e.isTrusted || !rec.on) return;
    let slot = slots.get(e.pointerId);
    if (slot === undefined) {
      if (phase !== "down") return;   // a touch that began before recording started
      const used = new Set([...slots.values()].map((s) => s.id));
      let id = 0;
      while (used.has(id)) id++;
      slot = { id, x: 0, y: 0 };
      slots.set(e.pointerId, slot);
    } else if (phase === "down") phase = "move";
    if (touchEnds(phase)) slots.delete(e.pointerId);
    const id = slot.id;
    // pointercancel (e.g. the browser took the gesture over for scrolling) carries no position: end it where it was
    const [x, y] = cancel ? [slot.x, slot.y] : dom.toLogical(e.clientX, e.clientY);
    slot.x = x; slot.y = y;
    const ev = touchShape({ id, x, y, phase, pressure: touchEnds(phase) ? 0 : e.pressure });
    if (phase === "move") {   // keep only the latest position of a finger per frame
      for (let i = rec.pending.length - 1; i >= 0; i--) {
        const p = rec.pending[i];
        if (p.type !== "touch" || p.id !== id) continue;
        if (p.phase === "move") { rec.pending.splice(i, 1); }
        break;
      }
    }
    push(ev);
  };
  G.addEventListener("pointermove", (e) => (e.pointerType === "touch" ? touch(e, "move") : mouse(e)), opt);
  G.addEventListener("pointerdown", (e) => (e.pointerType === "touch" ? touch(e, "down") : mouse(e, true)), opt);
  G.addEventListener("pointerup", (e) => (e.pointerType === "touch" ? touch(e, "up") : mouse(e, false)), opt);
  G.addEventListener("pointercancel", (e) => { if (e.pointerType === "touch") touch(e, "cancel", true); }, opt);
  G.addEventListener("wheel", (e) => { if (e.isTrusted) push({ type: "wheel", dy: e.deltaY * (e.deltaMode === 1 ? 32 : 1) }); }, opt);
}

// ------------------------------------------------------------------ transport

async function connect(addr, onMessage, onClose) {
  const attempts = 40;
  if (BROWSER && G.WebSocket) {
    for (let i = 0; ; i++) {
      try {
        const ws = await new Promise((res, rej) => {
          const s = new G.WebSocket(`ws://${addr}/`);
          s.onopen = () => res(s);
          s.onerror = () => rej(new Error(`can't reach Witness at ws://${addr}/`));
        });
        ws.onmessage = (e) => { for (const line of String(e.data).split("\n")) if (line.trim()) onMessage(line); };
        ws.onclose = onClose;
        return { send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
      } catch (e) {
        if (i >= attempts) throw e;
        await new Promise((r) => real.setTimeout(r, 250));
      }
    }
  }
  if (!NODE) throw new Error("witness: no WebSocket and no Node 'net' here, so there is no way to connect");
  const net = await import(/* @vite-ignore */ /* webpackIgnore: true */ "node:" + "net");
  const [host, port] = addr.includes(":") ? [addr.slice(0, addr.lastIndexOf(":")), +addr.slice(addr.lastIndexOf(":") + 1)] : ["127.0.0.1", +addr];
  for (let i = 0; ; i++) {
    try {
      const sock = await new Promise((res, rej) => {
        const s = net.connect(port, host, () => res(s));
        s.once("error", rej);
      });
      sock.setNoDelay(true);
      sock.setEncoding("utf8");   // a StringDecoder: a multibyte char split across chunks stays whole
      let buf = "";
      sock.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) onMessage(line); }
      });
      sock.on("error", () => {});
      sock.on("close", onClose);
      return { send: (o) => sock.write(JSON.stringify(o) + "\n"), close: () => sock.end() };
    } catch (e) {
      if (i >= attempts) throw new Error(`witness: can't reach ${addr} (${e.message})`);
      await new Promise((r) => real.setTimeout(r, 250));
    }
  }
}

// ------------------------------------------------------------------ protocol

let conn = null;
let chain = Promise.resolve();
const perfStats = { frames: 0, ms: 0 };

function callsList() {
  return Object.entries(H.calls || {}).map(([name, c]) => {
    const o = { name };
    if (c && typeof c === "object") { if (c.args) o.args = c.args; if (c.help) o.help = c.help; }
    return o;
  });
}

function detectEngine() {
  if (H.engine) return H.engine;
  const libs = [];
  if (G.Phaser && G.Phaser.VERSION) libs.push(`Phaser ${G.Phaser.VERSION}`);
  if (G.THREE && G.THREE.REVISION) libs.push(`three.js r${G.THREE.REVISION}`);
  if (G.PIXI && G.PIXI.VERSION) libs.push(`PixiJS ${G.PIXI.VERSION}`);
  if (G.BABYLON && G.BABYLON.Engine) libs.push(`Babylon.js ${G.BABYLON.Engine.Version || ""}`.trim());
  if (BROWSER && G.navigator && /Electron\//.test(G.navigator.userAgent)) libs.push("Electron");
  if (G.__TAURI__ || G.__TAURI_INTERNALS__) libs.push("Tauri");
  return libs.length ? libs.join(" + ") : BROWSER ? "browser (canvas)" : `node ${process.versions.node}`;
}

function hello() {
  const caps = ["step", "input", "snapshot", "eval", "logs", "perf"];
  if (H.reset) caps.unshift("reset");
  if (H.screenshot || BROWSER) caps.push("screenshot");
  if (H.audio || sources.length || (BROWSER && G.OfflineAudioContext && CFG.webaudio !== false)) caps.push("audio");
  if (H.calls && Object.keys(H.calls).length) caps.push("call");
  const msg = { protocol: 1, name: H.name || (BROWSER ? document.title : "") || "game", engine: detectEngine(), language: H.language || "javascript", fps, capabilities: caps, adapter: `witness-js ${VERSION}` };
  const size = BROWSER ? dom.logicalSize() : H.size;
  if (Array.isArray(size)) msg.size = size.map((n) => Math.round(n));
  const calls = callsList();
  if (calls.length) msg.calls = calls;
  if (H.keys) msg.keys = H.keys;
  if (H.touch) msg.touch = true;      // the game handles touch itself: no mouse fallback for finger 0
  return { hello: msg };
}

async function evaluate(expr) {
  const scope = Object.assign({}, typeof H.scope === "function" ? H.scope() : H.scope || {});
  scope.witness = api;
  if (/\bstate\b/.test(expr) && !("state" in scope) && H.snapshot) scope.state = jsonSafe(await H.snapshot());
  const names = Object.keys(scope).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  let fn;
  try { fn = new Function(...names, `return (${expr}\n);`); }          // an expression
  catch { fn = new Function(...names, String(expr)); }                 // statements (use 'return' for a value)
  let v = fn.apply(G, names.map((k) => scope[k]));
  if (v && typeof v.then === "function") v = await v;
  return v;
}

async function doStep(m) {
  const n = Math.max(1, m.frames | 0 || 1);
  const dflt = +m.dt > 0 ? +m.dt : 1 / fps;
  const yieldEach = sched.raf || sched.timers || H.yieldEachFrame;
  const t0 = real.now();
  for (let i = 0; i < n; i++) {
    const dt = Array.isArray(m.dts) && +m.dts[i] > 0 ? +m.dts[i] : dflt;
    applyInputs(sim.frame);
    runFrame(dt);
    if (sources.length) await renderAudio(false);
    sim.frame++;
    sim.time += dt;
    if (yieldEach) await macrotask();
  }
  perfStats.frames = n;
  perfStats.ms = real.now() - t0;
  return { frame: sim.frame, time: sim.time };
}

async function doReset(m) {
  releaseAllInput();
  reseed(m.seed ?? 1);
  clock.align();
  // the audio epoch first, so sounds the game's reset starts (music...) belong to the new run
  audioMark = audioEpoch = audioClock.t;
  audioClock.since = 0;
  audioReadSince = 0;
  // a reset starts silent: tails still ringing from the previous run must not leak into this one
  // (WebAudio nodes the game scheduled are its own: its reset should stop them)
  for (const s of sources) {
    s.read = 0;
    if (s.realign) await s.realign();
    const a = epochIndex(s);
    if (s.clear) s.clear(a); else s.drop(a);
  }
  await H.reset({ seed: currentSeed, scene: m.scene, params: m.params || {} });
  sim.frame = 0;
  sim.time = 0;
  frameEvents = [];
  return {};
}

async function handle(m) {
  switch (m.cmd) {
    case "reset":
      if (!H.reset) throw new Error("this game has no reset handler (pass reset() to witness.start)");
      return doReset(m);
    case "input": queueInput(m.events); return {};
    case "step": return doStep(m);
    case "snapshot": {
      const state = H.snapshot ? jsonSafe(await H.snapshot()) : {};
      return { frame: sim.frame, time: sim.time, state: pickPaths(state, m.paths) };
    }
    case "screenshot": return screenshot(+m.scale > 0 ? +m.scale : 1);
    case "audio": {
      if (H.audio) { const r = await H.audio(); return r && r.data && typeof r.data !== "string" ? { ...r, data: b64(r.data) } : r; }
      return readAudio();
    }
    case "call": {
      const c = (H.calls || {})[m.name];
      const fn = typeof c === "function" ? c : c && (c.run || c.fn);
      if (!fn) throw new Error(`unknown call '${m.name}'${H.calls ? ` (calls: ${Object.keys(H.calls).join(", ")})` : ""}`);
      return { result: jsonSafe(await fn(...(Array.isArray(m.args) ? m.args : []))) ?? null };
    }
    case "eval": return { value: jsonSafe(await evaluate(String(m.expr))) ?? null };
    case "logs": return { logs: logs.splice(0) };
    case "perf": {
      const extra = H.perf ? jsonSafe(await H.perf()) : {};
      return { frame_ms: perfStats.frames ? perfStats.ms / perfStats.frames : 0, ...extra, counts: { raf_callbacks: sched.rafs.size, timers: sched.tasks.size, ...(extra && extra.counts) } };
    }
    case "quit": {
      real.setTimeout(() => quit(), 20);
      return {};
    }
    default: throw new Error(`unknown command '${m.cmd}'`);
  }
}

function onMessage(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!isObj(m) || m.cmd == null) return;
  chain = chain.then(async () => {
    let reply;
    try { reply = { id: m.id, ok: true, ...(await handle(m)) }; }
    catch (e) { reply = { id: m.id, ok: false, error: e && e.message ? e.message : String(e) }; }
    try { conn && conn.send(reply); } catch (e) { reportError(e, "sending a reply"); }
  });
}

function detach() {
  // Back to normal play if the game keeps running (attached sessions, or the CLI went away).
  if (BROWSER && sched.on) startRealPump(realFrame);
}

function quit() {
  try { if (H.quit) H.quit(); } catch (e) { reportError(e, "quit handler"); }
  try { conn && conn.close(); } catch { /* gone */ }
  conn = null;
  if (NODE && !BROWSER && H.exitOnQuit !== false) process.exit(0);
  else detach();
}

function onClose() {
  if (!conn) return;
  conn = null;
  if (NODE && !BROWSER && H.exitOnQuit !== false) { try { if (H.quit) H.quit(); } finally { process.exit(0); } }
  else detach();
}

// ------------------------------------------------------------------ public API

/**
 * Hand the game to Witness. Call once, after assets are loaded and the game can run.
 * In witness mode: connects, sends the hello and from then on the game only advances on `step`.
 * In record mode: performs reset(seed) and records every frame. Otherwise: returns at once.
 */
async function start(options = {}) {
  if (started) throw new Error("witness.start() was already called");
  started = true;
  Object.assign(H, options);
  fps = +options.fps > 0 ? +options.fps : 60;
  if (MODE === "off") return api;
  if (MODE === "record") {
    if (options.seed != null) reseed(options.seed);
    clock.align();
    if (H.reset) await H.reset({ seed: currentSeed, scene: undefined, params: {} });
    rec.sink = NODE && !BROWSER ? await nodeRecordSink(CFG.record) : browserRecordSink(String(CFG.record));
    beginRecording();            // the real pump (if any) records every frame from now on
    return api;
  }
  // witness mode
  for (const m of options.mixers || []) if (!(m instanceof Mixer)) throw new Error("witness.start: mixers must come from witness.createMixer()");
  try {
    conn = await connect(CFG.addr, onMessage, onClose);
  } catch (e) {
    started = false;
    if (real.console) real.console.error.call(G.console, `[witness] ${e.message}`);
    throw e;
  }
  pump = "step";              // from the hello on, frames run only on 'step'
  conn.send(hello());
  return api;
}

/** Node / custom loops: take over setTimeout, setInterval, performance.now and Date (browsers do this at import). */
function takeover(opts = {}) {
  if (MODE === "off") return false;
  installTakeover({ raf: opts.raf !== false, timers: opts.timers !== false });
  if (pump === "none" && !(MODE === "witness" && started)) startRealPump(realFrame);
  return true;
}

/**
 * Normal play with recording on: append one replay line. Returns the dt to simulate with.
 * (Not needed when takeover() is on: the pump records every frame itself.)
 */
function recordFrame(dt, events) {
  if (!rec.on) return dt;
  const q = clock.dtTicks(dt) / TICK / 1000;   // quantized, so the replay feeds back exactly the same dt
  clock.ticks += clock.dtTicks(dt);
  recordFrameNow(q, events);
  return q;
}

const api = {
  version: VERSION,
  /** "witness" | "record" | "off" */
  mode: MODE,
  /** True when Witness drives the game (WITNESS_ADDR / ?witness=). */
  active: () => MODE === "witness",
  recording: () => rec.on,
  start,
  takeover,
  /** The seed for the game's own RNGs (from reset, the recording header, or random). */
  seed: () => currentSeed,
  /** Seeded random in [0, 1): the same stream Math.random uses in witness/record mode. */
  random: () => rng(),
  /** witness.log("coin collected") or witness.log("warn", "low fps"): a game log line for Witness. */
  log(level, ...message) {
    if (["info", "warn", "error"].includes(level)) pushLog(level, formatArgs(message));
    else pushLog("info", formatArgs([level, ...message]));
  },
  /**
   * witness.sound("jump") or witness.sound("hit", { volume: 0.8, pos: [x, y] }): announce a sound the game just
   * started, so 'witness listen' can name it and tie it to its cause (docs/PROTOCOL.md §3). No-op unless Witness
   * drives the game.
   */
  sound(name, { volume, pos } = {}) {
    if (MODE !== "witness" || !conn) return;
    const ev = { event: "sound", name: String(name), frame: sim.frame };
    if (typeof volume === "number" && Number.isFinite(volume)) ev.volume = volume;
    if (Array.isArray(pos) && pos.length >= 2 && pos.every((v) => Number.isFinite(+v))) ev.pos = [+pos[0], +pos[1]];
    try { conn.send(ev); } catch { /* the connection is gone: nothing to tell */ }
  },
  mark(label = "mark") { if (rec.on) rec.mark = String(label); },
  recordFrame,
  recordInput(ev) { if (rec.on && isObj(ev)) rec.pending.push(ev); },
  /** Record a finger (Node / custom loops): id 0 = first finger down, game pixels, phase "down" | "move" | "up" | "cancel" (the system ended it; replays as cancel). */
  recordTouch(id, x, y, phase = "move", pressure) { if (rec.on) rec.pending.push(touchShape({ id, x, y, phase, pressure })); },
  saveRecording() { return rec.sink && rec.sink.save ? rec.sink.save() : null; },
  /** Input events applied at the current frame (for games that pull input). */
  inputEvents: () => frameEvents.slice(),
  /** Keys / mouse / touches (finger id -> {x, y, pressure} while down) / pad / actions as injected by Witness. */
  input: inputState,
  createMixer: (opts) => new Mixer(opts),
  get frame() { return sim.frame; },
  get time() { return sim.time; },
  /** The real (un-virtualized) timers and clocks, for code that must not be frozen. */
  real,
};

// ------------------------------------------------------------------ install (runs at import)

if (MODE === "witness") {
  Math.random = () => rng();
  if (CFG.console !== false) captureConsole();
  captureErrors();
  if (BROWSER) {
    if (CFG.takeover !== false) installTakeover({ raf: CFG.raf !== false, timers: CFG.timers !== false });
    patchCanvasContexts();
    installVirtualGamepad();
    if (CFG.webaudio !== false) installWebAudioTap();
    // Until the hello, frames follow the display so the engine can boot and load, but each one
    // advances exactly 1/fps: engines that average recent dts (Phaser) then never hold odd values.
    if (sched.on) startRealPump(() => runFrame(1 / fps));
  } else if (CFG.takeover) {
    takeover({ raf: CFG.raf, timers: CFG.timers !== false });
  }
} else if (MODE === "record") {
  Math.random = () => rng();
  if (BROWSER) {
    if (CFG.takeover !== false) installTakeover({ raf: CFG.raf !== false, timers: CFG.timers !== false });
    installRecorderListeners();
    if (sched.on) startRealPump(realFrame);   // records once start() ran
  }
}

export { api as witness, start, takeover, recordFrame, Mixer, MODE as mode };
export const active = api.active;
export const seed = api.seed;
export const random = api.random;
export const log = api.log;
export const mark = api.mark;
export const sound = api.sound;
export const createMixer = api.createMixer;
export default api;
