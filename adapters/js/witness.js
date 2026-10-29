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

// One adapter per page: the first copy to run builds it and keeps it in globalThis.__witnessApi; any later copy (the
// page's own import after Witness injected the adapter before every page script: launch.inject, GUIDE.md §1b; or a
// bundler's duplicate) hands out that same instance instead of taking the page over a second time.
function createWitness() {
const DEFAULT_ADDR = "127.0.0.1:7357";
const VERSION = "1.0.0";
// the Witness release this copy came from: the CLI says so when a game's copy is older than the CLI (a core test keeps
// it equal to package.json)
const WITNESS_VERSION = "0.7.11";

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
    if (c.epoch == null && q.has("witness_epoch")) c.epoch = q.get("witness_epoch");
    if (c.audioCapture == null && q.has("witness_audio")) c.audioCapture = q.get("witness_audio") !== "0";
    for (const k of ["takeover", "raf", "timers", "webaudio", "console", "animations", "videos", "virtualEnded", "realtimeWatch"]) {
      if (c[k] == null && q.has(`witness_${k}`)) c[k] = q.get(`witness_${k}`) !== "0";
    }
  }
  if (NODE && process.env) {
    const e = process.env;
    if (c.addr == null && e.WITNESS_ADDR) c.addr = e.WITNESS_ADDR;
    if (c.addr == null && (process.argv || []).includes("--witness")) c.addr = DEFAULT_ADDR;
    if (c.record == null && e.WITNESS_RECORD) c.record = e.WITNESS_RECORD;
    if (c.seed == null && e.WITNESS_SEED) c.seed = +e.WITNESS_SEED;
    if (c.epoch == null && e.WITNESS_EPOCH) c.epoch = e.WITNESS_EPOCH;
    if (c.audioCapture == null && e.WITNESS_AUDIO) c.audioCapture = e.WITNESS_AUDIO !== "0";
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
let rng = makeRng(currentSeed), rngCalls = 0;   // rngCalls: seeded draws since the last reseed (perf.lazy_draw.rng: doctor's draw-reads-Math.random check)
const rand = () => { rngCalls++; return rng(); };
function reseed(seed) { currentSeed = normSeed(seed); rng = makeRng(currentSeed); rngCalls = 0; }

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
// Lazy drawing (step "draw": "last", docs/PROTOCOL.md §3): only the step's final frame is observed, so the frames before
// it run with witness.drawing false and a game that checks it skips its draw there. reads: how often the game asked
// (perf.lazy_draw; doctor checks such games for draws that change state); skipped: frames run with drawing off.
const lazy = { drawing: true, stale: false, reads: 0, skipped: 0, redraw: null };
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

// ------------------------------------------------------------------ real-time activity (browser, witness mode)
//
// Game code that runs while Witness is NOT driving it: between commands, on the browser's own clock. Typically a
// timer, rAF loop or listener a classic <script> made before the adapter took over (it stays on a REAL timer: The
// Fort's setInterval(idleBake, 2000) re-baked terrain at wall-clock moments, so screenshots differed). Cheap
// observation points (Math.random, performance.now, Date.now / new Date(), canvas 2D and WebGL draws, rAF
// registration) check one boolean; the first hits build a stack for their site. Witness is "driving" from a command's
// arrival until one macrotask after its reply (so work the game queued meanwhile, e.g. a framework's MessageChannel
// render, still counts as driven), and while trusted input (the CLI's dom: events) is dispatched. Armed after the
// first command (code right after `await witness.start()` is boot). Reported in perf.realtime; doctor warns.
const rt = { armed: false, on: false, busy: 0, idle: false, calls: 0, apis: {}, sites: [], seen: new Set(), stacks: {}, early: null };
const rtSync = () => { rt.idle = rt.on && rt.busy === 0; };
function rtHold() { rt.busy++; rt.idle = false; }
function rtRelease() { macrotask().then(() => { rt.busy = Math.max(0, rt.busy - 1); if (rt.armed) rt.on = true; rtSync(); }); }
const OWN_FRAME = /witness(-injected)?\.js|__playwright|<anonymous>|^\s*at (new )?Promise|^\s*at Array\./;
function rtNote(api) {
  rt.calls++;
  rt.apis[api] = (rt.apis[api] || 0) + 1;
  if ((rt.stacks[api] || 0) >= 4 || rt.sites.length >= 8) return;   // a few stacks per kind: one noisy source can't hide the next
  rt.stacks[api] = (rt.stacks[api] || 0) + 1;
  const frames = String(new Error().stack || "").split("\n").filter((l) => /:\d+:\d+\)?\s*$/.test(l) && !OWN_FRAME.test(l)).slice(0, 6);
  const fmt = (l) => {
    const m = /^\s*(?:at\s+)?(?:(.*?)\s+\()?(?:(.*?)@)?(.*?):(\d+):(\d+)\)?\s*$/.exec(l);
    if (!m) return { at: l.trim(), fn: null, text: l.trim() };
    const file = m[3].replace(/[?#].*$/, "").split(/[\\/]/).pop() || m[3], fn = (m[1] || m[2] || "").replace(/^async /, "") || null;
    return { at: `${file}:${m[4]}`, fn, text: `${fn ? `${fn} ` : ""}(${file}:${m[4]}:${m[5]})` };
  };
  const top = frames.length ? fmt(frames[0]) : { at: "(unknown: no page frame on the stack)", fn: null };
  if (rt.seen.has(top.at) || rt.sites.length >= 8) return;
  rt.seen.add(top.at);
  rt.sites.push({ api, at: top.at, fn: top.fn, frame: sim.frame, stack: frames.map((l) => fmt(l).text).join(" ← ") });
}
/** Only `window.WITNESS_CONFIG = {...}` (the documented page config, GUIDE §2): nothing that can start a timer. */
function configOnly(text) {
  const t = String(text || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1").trim();
  const m = /^(?:(?:window|globalThis|self)\.|var\s+)WITNESS_CONFIG\s*=\s*\{/.exec(t);
  if (!m) return false;
  let d = 0, q = null, i = m[0].length - 1;
  for (; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") d++;
    else if (c === "}" && --d === 0) break;
  }
  return d === 0 && /^[\s;]*$/.test(t.slice(i + 1));
}
/** Classic scripts already in the page when the adapter loaded (they ran first: their timers stay on real time). */
function earlyScripts() {
  if (!BROWSER || !G.document || !G.document.scripts) return { inline: 0, src: [] };
  const classic = Array.from(G.document.scripts).filter((s) => !s.type || /^(text|application)\/(x-)?(java|ecma|j)script$/i.test(s.type));
  return { inline: classic.filter((s) => !s.src && !configOnly(s.text)).length, src: classic.filter((s) => s.src).map((s) => s.src.replace(/[?#].*$/, "").split("/").pop()).slice(0, 8) };
}
function realtimeReport() {
  return { calls: rt.calls, apis: { ...rt.apis }, sites: rt.sites.slice(), early_scripts: rt.early || { inline: 0, src: [] } };
}
/** Wrap obj[name] so a call made while Witness is idle is counted (label: what the report calls it). */
function observe(obj, name, label) {
  const f = obj && Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null;
  if (typeof f !== "function") return;
  obj[name] = function () { if (rt.idle) rtNote(label); return f.apply(this, arguments); };
}
function installRealtimeWatch() {
  rt.early = earlyScripts();
  for (const [cls, names] of [["CanvasRenderingContext2D", ["drawImage", "fillRect", "clearRect", "putImageData", "fillText", "fill", "stroke"]], ["OffscreenCanvasRenderingContext2D", ["drawImage", "fillRect", "clearRect", "putImageData"]],
    ["WebGLRenderingContext", ["drawArrays", "drawElements"]], ["WebGL2RenderingContext", ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]]]) {
    const P = G[cls] && G[cls].prototype;
    if (P) for (const n of names) observe(P, n, `${cls.replace("RenderingContext", "").replace(/^WebGL2?$/, "WebGL")}.${n}`);
  }
  // trusted input (the CLI's dom: tap / click / key through Playwright, or a person on a watched page) is driven input
  const ext = (e) => { if (e.isTrusted && rt.armed) { rtHold(); rtRelease(); } };
  // (boundary events come before the move; a tap's compatibility mouse events come in a later task than touchend)
  for (const t of ["keydown", "keyup", "keypress", "beforeinput", "input", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerover", "pointerenter", "pointerout", "pointerleave", "gotpointercapture", "lostpointercapture",
    "mousedown", "mousemove", "mouseup", "mouseover", "mouseenter", "mouseout", "mouseleave", "click", "dblclick", "auxclick", "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "contextmenu"]) G.addEventListener(t, ext, { capture: true, passive: true });
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
// The virtual Date's start (ms since 1970): WITNESS_CONFIG.epoch / ?witness_epoch= / WITNESS_EPOCH, an ISO date, a
// number of ms, or "today" (this run's date, 00:00 UTC). Default 2026-01-01T00:00:00Z. The CLI sends witness.json's
// clock.epoch (resolved and pinned once per run) here and with every reset, and records it in replays.
function epochMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v))) return Math.floor(+v);
  if (String(v).toLowerCase() === "today") { const d = new real.Date(); return real.Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  const t = +new real.Date(String(v));
  return Number.isFinite(t) ? t : null;
}
const DEFAULT_EPOCH = real.Date.UTC(2026, 0, 1);
const clock = {
  // witness mode starts the clock at 0, so performance.now() and rAF timestamps read the same in every run
  ticks: MODE === "witness" ? 0 : Math.round(real.now() * TICK),
  dateBase: 0,
  now() { return this.ticks / TICK; },
  date() { return Math.floor(this.dateBase + this.ticks / TICK); },
  // Rounded DOWN: engines often cap dt at 1000/fps ms (Phaser, many hand-written loops), and a
  // quantized dt just above that cap would be clamped in some frames and not in others.
  dtTicks(sec) { return Math.max(1, Math.floor(sec * 1000 * TICK + 1e-6)); },
  /** Line Date.now() up on a whole millisecond, so its integer steps repeat identically after every reset. */
  align() { const n = this.ticks / TICK; this.dateBase = Math.ceil(this.dateBase + n) - n; },
};
// the configured start, kept: a reset with an epoch moves clock.epoch; the hello reports this one, so the CLI can
// restore it for tests without their own after a test that set one
const cfgEpoch = epochMs(CFG.epoch);
clock.epoch = cfgEpoch ?? DEFAULT_EPOCH;
clock.dateBase = clock.epoch - clock.now();

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
  if (anim.on) syncAnimations();
}

// ------------------------------------------------------------------ CSS animations / transitions on the virtual clock
//
// The Web Animations timeline runs on real time: a CSS transition or keyframe animation would be wherever the real
// clock put it when a screenshot is taken. Every frame each animation of the document (CSS transitions, CSS
// animations, element.animate()) is held at playbackRate 0 and its currentTime set from the virtual clock, counted
// from the virtual time it was created at. Past its end it is finished (rate restored, finish()), so animationend /
// transitionend still fire; those events (and the start / iteration ones) are dispatched by the browser's next
// rendering update, so a frame that started, finished or wrapped an animation waits for one real display frame before
// the next frame runs: the game's handlers run at the same virtual time in every run. Infinite animations are moved
// along too, and <video> elements are paused (they play on real time). Off: WITNESS_CONFIG.animations = false.
// One started between frames (a call, an input listener, boot code, an async callback) is held from the moment it
// exists, not from the end of the next frame (0.7.11): element.animate() is hooked, a MutationObserver (class / style /
// attributes / inserted elements) and animationstart / transitionrun listeners catch CSS ones in a real animation-frame
// callback (before the browser draws them), a call waits for that before it answers, and a step catches any left
// before its first frame. So the first frame drawn or screenshotted shows it at its virtual start, in every run.
const anim = { on: false, state: new WeakMap(), flush: false, videos: true, pending: false, rafQueued: false, mo: null };

/** Hold one animation on the virtual clock at now (st.rate null: created by the element.animate() hook at st.t0). */
function syncOne(a, now, tl) {
  if (a.timeline && tl && a.timeline !== tl) return;   // scroll-driven: not a clock
  let st = anim.state.get(a), fresh = false;
  const ps = a.playState;
  if (ps === "idle") return;
  if (!st || st.rate == null) {
    fresh = true;
    st = { t0: st ? st.t0 : now, rate: a.playbackRate > 0 ? a.playbackRate : 1, done: ps === "finished", iter: null };
    anim.state.set(a, st);
    if (st.done) return;   // already over (fill: forwards): it stays where it ended
    anim.flush = true;   // start events (animationstart, transitionrun/start) go out with the next rendering update
  }
  if (ps === "paused") { st.t0 = now - (+a.currentTime || 0) / st.rate; return; }   // the game paused it: resume from there
  if (st.done) {
    if (ps === "finished") return;
    st.done = false; st.t0 = now - (+a.currentTime || 0) / st.rate;   // played again (a.play() after the end)
  } else if (!fresh && a.playbackRate > 0) { st.rate = a.playbackRate; st.t0 = now - (+a.currentTime || 0) / st.rate; }   // the game set a rate: on from here
  const t = (now - st.t0) * st.rate;
  const timing = a.effect ? a.effect.getComputedTiming() : null;
  const end = timing ? timing.endTime : Infinity;
  if (Number.isFinite(end) && t >= end) {
    a.playbackRate = st.rate;
    a.finish();
    st.done = true;
    anim.flush = true;
    return;
  }
  if (a.playbackRate !== 0) a.playbackRate = 0;
  a.currentTime = t;
  if (G.CSSAnimation && a instanceof G.CSSAnimation && a.effect) {
    const it = a.effect.getComputedTiming().currentIteration;
    if (st.iter != null && it !== st.iter) anim.flush = true;   // animationiteration
    st.iter = it;
  }
}

/** all: every animation (the end of a frame); else only the ones not held yet (caught between frames). */
function syncAnimations(all = true) {
  let list;
  anim.pending = false;
  if (anim.mo) anim.mo.takeRecords();   // mutations so far are covered by this flush: no extra catch frame for them
  try { list = G.document.getAnimations(); } catch { return; }   // also flushes style: new transitions exist from here
  const now = clock.now(), tl = G.document.timeline;
  for (const a of list) {
    if (!all) { const st = anim.state.get(a); if (st && st.rate != null) continue; }
    try { syncOne(a, now, tl); } catch (e) { warnOnce("css-anim", `a CSS / Web Animation could not be put on the virtual clock: ${e && e.message}`); }
  }
  if (all && anim.videos) for (const v of G.document.querySelectorAll("video")) if (!v.paused) { try { v.pause(); } catch { /* gone */ } }
}
/** Something may have started an animation: catch it in the next real animation frame, before it is drawn. */
function animSoon() {
  anim.pending = true;
  if (anim.rafQueued || !real.requestAnimationFrame) return;
  anim.rafQueued = true;
  real.requestAnimationFrame(() => { anim.rafQueued = false; if (anim.on && anim.pending) syncAnimations(false); });
}
/** A mutation that can start one: an attribute (class / style / data-*) or an inserted element; text updates are skipped. */
const animRecord = (r) => r.type === "attributes" || Array.prototype.some.call(r.addedNodes, (n) => n.nodeType === 1);
/** Did anything that can start an animation happen since the last catch? (takes the observer's queued records) */
function animMutated() {
  if (anim.pending || !anim.mo) return true;
  return anim.mo.takeRecords().some(animRecord);
}
/** Hold one animation not held yet (no style flush: it is already made). */
function catchOne(a) {
  const st = anim.state.get(a);
  if (anim.on && !(st && st.rate != null)) { try { syncOne(a, clock.now(), G.document.timeline); } catch { /* the frame catches it */ } }
}
/** Hook element.animate() and watch the DOM for the CSS kind (installed with anim.on). */
function installAnimationCatch() {
  const EP = G.Element && G.Element.prototype;
  if (EP && typeof EP.animate === "function" && !EP.animate.__witness) {
    const realAnimate = EP.animate;
    EP.animate = function animate(...args) {
      const a = realAnimate.apply(this, args);
      // the virtual time it was made at (a timer mid-frame: its own time); held in a microtask or the next real frame,
      // whichever comes first, after the caller's own setup (a.playbackRate = 2, a.pause()) ran
      if (anim.on && a) { try { anim.state.set(a, { t0: clock.now(), rate: null }); animSoon(); queueMicrotask(() => catchOne(a)); } catch { /* odd engine */ } }
      return a;
    };
    EP.animate.__witness = true;
  }
  if (typeof G.MutationObserver === "function" && G.document.documentElement) {
    // a syncAnimations takes the records it covers, so a frame's own mutations cost no extra catch frame
    const mo = anim.mo = new G.MutationObserver((recs) => { if (anim.on && !anim.pending && recs.some(animRecord)) animSoon(); });
    mo.observe(G.document.documentElement, { attributes: true, childList: true, subtree: true });
  }
  // started by something no mutation shows (:hover, a media query): the events come one rendering update in
  const onStart = (e) => { if (anim.on && e.target && e.target.getAnimations) for (const a of e.target.getAnimations()) catchOne(a); };
  for (const t of ["animationstart", "transitionrun", "transitionstart"]) G.document.addEventListener(t, onStart, true);
}

/** After a call: animations it started are held at the call's virtual time and their start events sent before the
 *  reply (the MutationObserver's microtask runs before this continuation), whether a real frame came between or not. */
async function animSettle() {
  await null;
  if (anim.pending) syncAnimations(false);
  if (anim.flush) await renderingUpdate();
}

/** One real rendering update, so animation events queued by this frame are dispatched before the next one. */
function renderingUpdate() {
  anim.flush = false;
  return new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    if (real.requestAnimationFrame) real.requestAnimationFrame(() => fin());
    real.setTimeout(fin, 120);   // a hidden page gets no rendering updates
  });
}

/** Finite animations still running (0 when the screen has settled): globalThis.__witnessAnimating(). */
function animatingCount() {
  if (!BROWSER || !G.document.getAnimations) return 0;
  let n = 0;
  const tl = G.document.timeline;
  for (const a of G.document.getAnimations()) {
    if (a.timeline && tl && a.timeline !== tl) continue;
    const ps = a.playState;
    if (ps === "idle" || ps === "finished" || ps === "paused") continue;
    const st = anim.state.get(a);
    if (st && st.done) continue;
    const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
    if (Number.isFinite(end)) n++;
  }
  return n;
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
  if (P) Object.defineProperty(P, "now", { value: () => { if (rt.idle) rtNote("performance.now"); return clock.now(); }, configurable: true, writable: true });
  const RealDate = real.Date;
  function WitnessDate(...a) {
    if (rt.idle && !a.length) rtNote("Date");
    if (!new.target) return new RealDate(clock.date()).toString();
    return Reflect.construct(RealDate, a.length ? a : [clock.date()], new.target);
  }
  WitnessDate.prototype = RealDate.prototype;
  WitnessDate.now = () => { if (rt.idle) rtNote("Date.now"); return clock.date(); };
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
    G.requestAnimationFrame = (cb) => { if (rt.idle) rtNote("requestAnimationFrame"); const id = sched.rafNext++; sched.rafs.set(id, cb); return id; };
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
    next();
  };
  // the display's frames, with a timer as a fallback: headless Chromium can stop giving a page animation frames (a
  // compositor-run CSS animation, e.g. an infinite spinner, next to a rAF loop), and the boot must go on regardless
  const next = () => {
    if (!(real.requestAnimationFrame && BROWSER)) { real.setTimeout(tick, 1000 / fps); return; }
    let done = false;
    const once = (ts) => { if (!done) { done = true; tick(ts); } };
    real.requestAnimationFrame(once);
    real.setTimeout(() => once(null), 100);
  };
  next();
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
// since of the last frame's render (to the quantum boundary at or before then) and of the last audio read (rendered to
// the boundary at or AFTER then): a running context's currentTime reads the furthest of the two, so one made or
// resumed now starts on that boundary too, whatever ran before (see tap.gridNow)
let audioFloorSince = 0, audioCeilSince = 0;
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
// A running context's 0 too (a suspended one reads 0 until it runs, as games checking currentTime > 0 expect): a
// context made by a tap reads 0 there, the same context in the next repeat pass n + 0.5 frames, and the sound the tap
// started at currentTime + 0.01 sat half a sample earlier in the first pass (off by up to 0.03: Euchre).
function frameTime(t, rate, running) {
  const n = Math.round(t * rate);
  if (!(t > 0 || (t === 0 && running)) || Math.abs(t * rate - n) > 1e-6) return t;
  return (n + 0.5) / rate;
}

// "ended" of a source node (AudioBufferSourceNode, OscillatorNode, ConstantSourceNode) on the virtual clock. The offline
// renderer posts its ended events whenever the render and the main thread get there: a frame early or late, not the
// same one each run, so a game counting live voices with src.onended = () => live-- dropped a different set of
// sounds each run (The Fort). Witness swallows the browser's event and fires its own, after the frame's render, for
// every source whose end (start time + the buffer's playable length over its playbackRate/detune, or its stop time) is
// at or before the render quantum the context's virtual clock is in: the same frame every run, never before the sound
// was rendered (a handler that disconnects the voice can't cut its tail). WITNESS_CONFIG.virtualEnded = false: off.
const endedQueue = new Map();   // node -> {node, tap, at, stopAt, off, dur, seq}
let endedSeq = 0;
const taps = new WeakMap();     // a captured context -> its tap
let tapRate = 0;                // a captured context's default rate (the capture's rate before any context exists)
function endOf(v) {
  const n = v.node;
  let e = v.stopAt;
  if (n.buffer && (!n.loop || v.dur != null) && n.playbackRate) {
    const r = n.playbackRate.value * Math.pow(2, (n.detune ? n.detune.value : 0) / 1200);
    const left = n.loop ? v.dur : Math.min(v.dur != null ? v.dur : Infinity, Math.max(0, n.buffer.duration - v.off));
    if (r > 0) e = Math.min(e, v.at + left / r);
  }
  return Math.max(v.at, e);   // stopped before it started: ends when it would have started
}
function fireEnded() {
  const due = [];
  for (const v of endedQueue.values()) {
    const by = v.tap.endedBy();
    if (by == null) { endedQueue.delete(v.node); continue; }   // closed context: its sources never end
    const e = endOf(v);
    if (e <= by + 1e-9) due.push([e, v]);
  }
  due.sort((a, b) => a[0] - b[0] || a[1].seq - b[1].seq);
  for (const [, v] of due) {
    endedQueue.delete(v.node);
    try { v.node.dispatchEvent(new Event("ended")); } catch (e) { reportError(e, "onended"); }
  }
}
function installVirtualEnded() {
  const SSN = G.AudioScheduledSourceNode && G.AudioScheduledSourceNode.prototype;
  if (!SSN || CFG.virtualEnded === false || !G.EventTarget) return;
  // the game's ended handlers are wrapped to ignore the browser's own (trusted) event: only Witness's reaches them
  // (a capture listener calling stopImmediatePropagation doesn't do it: Chrome runs an onended set earlier first)
  const ours = (n) => { try { return taps.has(n.context); } catch { return false; } };
  const skipTrusted = (fn, self) => function (e) { if (e && e.isTrusted) return; return typeof fn === "function" ? fn.call(self || this, e) : fn.handleEvent(e); };
  const od = Object.getOwnPropertyDescriptor(SSN, "onended");
  if (od && od.set) {
    const handlers = new WeakMap();
    Object.defineProperty(SSN, "onended", { configurable: true, enumerable: od.enumerable,
      get() { return handlers.has(this) ? handlers.get(this) : od.get.call(this); },
      set(fn) {
        if (!ours(this)) return od.set.call(this, fn);
        handlers.set(this, typeof fn === "function" ? fn : null);
        od.set.call(this, typeof fn === "function" ? skipTrusted(fn) : null);
      } });
  }
  const nAdd = G.EventTarget.prototype.addEventListener, nRemove = G.EventTarget.prototype.removeEventListener;
  const wrapped = new WeakMap();   // node -> Map(listener -> [wrapper per capture flag])
  const cap = (o) => (typeof o === "boolean" ? o : !!(o && o.capture));
  SSN.addEventListener = function (type, fn, opts) {
    if (type !== "ended" || !fn || !ours(this)) return nAdd.call(this, type, fn, opts);
    let m = wrapped.get(this);
    if (!m) wrapped.set(this, (m = new Map()));
    const ws = m.get(fn) || [null, null], c = +cap(opts);
    if (ws[c]) return;   // already added, as addEventListener does
    const once = opts && typeof opts === "object" && opts.once;
    const node = this, inner = skipTrusted(fn);
    ws[c] = function (e) { if (e && e.isTrusted) return; if (once) node.removeEventListener("ended", fn, { capture: !!c }); return inner.call(this, e); };
    m.set(fn, ws);
    return nAdd.call(this, type, ws[c], typeof opts === "object" && opts ? { ...opts, once: false } : opts);
  };
  SSN.removeEventListener = function (type, fn, opts) {
    const m = type === "ended" && fn ? wrapped.get(this) : null, ws = m && m.get(fn), c = +cap(opts);
    if (!ws || !ws[c]) return nRemove.call(this, type, fn, opts);
    nRemove.call(this, type, ws[c], opts);
    ws[c] = null;
  };
  const ABS = G.AudioBufferSourceNode && G.AudioBufferSourceNode.prototype;
  for (const P of [SSN, ABS]) {
    if (!P || !Object.prototype.hasOwnProperty.call(P, "start")) continue;
    const nStart = P.start;
    P.start = function (when, offset, duration) {
      const r = nStart.apply(this, arguments);
      const tap = taps.get(this.context);
      if (tap) {
        const ab = P === ABS;
        endedQueue.set(this, { node: this, tap, at: Math.max(+when || 0, tap.nowRendered()), stopAt: Infinity,
          off: ab ? Math.max(0, +offset || 0) : 0, dur: ab && duration != null ? Math.max(0, +duration) : null, seq: endedSeq++ });
      }
      return r;
    };
  }
  const nStop = SSN.stop;
  SSN.stop = function (when) {
    const r = nStop.apply(this, arguments);
    const v = endedQueue.get(this);
    if (v) v.stopAt = Math.max(+when || 0, v.tap.nowRendered());   // a later stop() replaces the earlier one, as in WebAudio
    return r;
  };
}

// decodeAudioData finishes on real time, whenever the decoder thread gets there: a WAV decoded on the first tap was
// ready a frame or several later depending on the machine's load, so the card sound a timer played 80 ms on was there
// in one run and missing in the next. Simulated time waits for it instead: a frame (and a call, sync or async) doesn't
// end while a decode is pending, so to the game every decode takes no time, the same in every run (up to 10 s real).
const decoding = new Set();
function installDecodeHold() {
  const P = G.BaseAudioContext ? G.BaseAudioContext.prototype : G.OfflineAudioContext && G.OfflineAudioContext.prototype;
  const nDecode = P && P.decodeAudioData;
  if (!nDecode) return;
  P.decodeAudioData = function () {
    const p = nDecode.apply(this, arguments);
    if (p && typeof p.then === "function") { decoding.add(p); const off = () => decoding.delete(p); p.then(off, off); }
    return p;
  };
}
async function decodesDone() {   // then one macrotask: the game's continuations (await decode... ready = true) ran
  let late = false, t;
  const give = new Promise((r) => { t = real.setTimeout(() => { late = true; r(); }, 10000); });   // a decode that never ends
  while (decoding.size && !late) { await Promise.race([Promise.allSettled([...decoding]), give]); await macrotask(); }
  real.clearTimeout(t);
  if (late) warnOnce("decode-late", "decodeAudioData still pending after 10 s: the frame went on without it (audio may differ between runs)");
}

/** In witness mode every AudioContext the game creates is an OfflineAudioContext rendered in step with simulated time. */
function installWebAudioTap() {
  const Native = G.OfflineAudioContext;
  if (!Native || !G.AudioWorkletNode) return;
  tapRate = +CFG.audioRate || 24000;
  const nSuspend = Native.prototype.suspend, nResume = Native.prototype.resume;
  const destGet = Object.getOwnPropertyDescriptor(G.BaseAudioContext ? G.BaseAudioContext.prototype : Native.prototype, "destination").get;
  const timeGet = Object.getOwnPropertyDescriptor(G.BaseAudioContext ? G.BaseAudioContext.prototype : Native.prototype, "currentTime").get;
  const seconds = +CFG.audioSeconds || 300, capture = CFG.audioCapture !== false;
  installVirtualEnded();
  installDecodeHold();
  function WitnessAudioContext(opts = {}) {
    const rate = (opts && opts.sampleRate) || +CFG.audioRate || 24000;
    // no capture (a play session: WITNESS_CONFIG.audioCapture false / ?witness_audio=0): nothing renders, and the clock
    // runs exactly as the capture's would (the same 128-frame steps, the same end at audioSeconds), so the game and its
    // "ended" events go the same way as in a replay with capture
    const len = Math.ceil(rate * seconds);
    const ctx = new Native({ numberOfChannels: 1, length: capture ? len : Math.ceil(rate), sampleRate: rate });
    const ctxTime = () => (capture ? timeGet.call(ctx) : tap.rendered / rate);
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
      const last = gaps[gaps.length - 1];
      // frozen again before the last gap's end (which can be after now, below): that gap goes on, counted once
      if (was === "running") { if (last && last[1] > at) last[1] = Infinity; else gaps.push([at, Infinity]); }
      else if (st === "running" && last) {
        // it runs again from the reset's 128-frame grid boundary a running context's currentTime reads now (tap.gridNow:
        // at or before now; after it right after an audio read), or the latest before it that keeps its quanta on the
        // grid: a sound started after a resume() on a tap is timed as in a pass where the context never stopped (made
        // frozen, it starts exactly there; see tap.anchor)
        const c = last[0] - tap.frozenAt(last[0]);   // the context's position, frozen since
        let end = tap.anchor + tap.gridNow() * 128 - (((-c % 128) + 128) % 128);
        if (end < last[0]) end += Math.ceil((last[0] - end) / 128) * 128;
        last[1] = end;
      }
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
      currentTime: { get: () => { const on = entry.st === "running"; return frameTime(ctxTime() + (tap.full && on ? audioClock.t - tap.fullAt : 0), rate, on); } },
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
    const tap = { rate, capture, born: audioClock.t, chunks: [], base: 0, received: 0, rendered: 0, started: false, dead: false, ready: null, frozenBase: 0 };
    // output position of the current simulated time, and output → context samples (the frozen gaps left out)
    tap.outNow = () => (tap.anchor != null ? tap.anchor + audioClock.since * rate : (audioClock.t - tap.born) * rate);
    tap.frozenAt = (o) => { let f = tap.frozenBase; for (const [g0, g1] of gaps) { if (g0 >= o) break; f += Math.min(o, g1) - g0; } return f; };
    tap.ctxAt = (o) => o - tap.frozenAt(o);
    tap.read = Math.round(audioReadSince * rate);   // created mid-run: start reading where the capture is
    // the context's clock in seconds: as rendered (where a start "now" lands), and the render quantum simulated time
    // is in (sources ending by then fire "ended" this frame; null: closed, they never end)
    tap.nowRendered = () => (tap.full ? ctxTime() + (entry.st === "running" ? audioClock.t - tap.fullAt : 0) : ctxTime());
    tap.endedBy = () => (entry.st === "closed" ? null : tap.dead ? tap.nowRendered() : (Math.floor(tap.ctxAt(tap.outNow()) / 128) * 128) / rate);
    tap.closed = () => entry.st === "closed";
    taps.set(ctx, tap);
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
    // simulated time maps to anchor + since x rate. A context made mid-run is anchored on the time since the reset
    // too (since is summed from 0 at each reset: the same floats every run), not on the clock since the page loaded:
    // its quanta then line up with the frames the same way every run (with 400 samples a frame, every 8th frame ends
    // exactly on a quantum and float noise in t - born floored it either side: a frame's render, currentTime and
    // the frame a source's "ended" fired at differed between runs). Its sample 0 is the quantum boundary of that grid
    // at or before now (counted from the reset, as an older context's boundaries are after its realign): a context
    // made by the first tap of a test then times its sounds exactly as the same context does in the next repeat pass,
    // when it already exists (rounded to "now", a tap 1/3 into a quantum put every sound 1/3 quantum off: Euchre).
    // Precisely, the boundary an existing context has rendered to (tap.gridNow): the last frame's (made by a timer
    // inside a frame: that frame's start), or after now when an audio read at this time rendered past it (was: a call
    // at the time of a capture put every sound 128 samples off in the pass that made the context).
    // The invariant kept from here on (realign, resume): anchor - frozen samples is a multiple of 128.
    tap.gridNow = () => Math.max(Math.floor(audioFloorSince * rate / 128), Math.ceil(audioCeilSince * rate / 128));
    tap.anchor = -tap.gridNow() * 128;
    tap.render = async (ceil) => {
      if (tap.dead) return;
      const pos = tap.ctxAt(tap.outNow()) / 128;
      await tap.renderTo((ceil ? Math.ceil(pos) : Math.floor(pos)) * 128);
    };
    tap.realign = async (prevSince) => {   // prevSince: the run's since just before the reset zeroed it
      if (tap.dead) return;
      const o = tap.anchor != null && prevSince != null ? tap.anchor + prevSince * rate : (audioClock.t - tap.born) * rate;
      const open = gaps.length && gaps[gaps.length - 1][1] === Infinity;
      if (open) { tap.anchor = Math.round(o); return; }   // frozen: nothing renders, the output timeline just goes on
      const target = Math.ceil(tap.ctxAt(o) / 128) * 128;
      await tap.renderTo(target);
      tap.anchor = target + tap.frozenAt(Infinity);
    };
    tap.renderTo = async (target) => {
      if (tap.dead) return;
      try {
        if (!capture) { if (target >= len) { tap.dead = true; tap.full = true; tap.fullAt = audioClock.t; } else if (target > tap.rendered) tap.rendered = target; return; }
        await tap.prepare();
        if (target <= tap.rendered) return;
        // the offline context's length is fixed when it is made: past it nothing more can be rendered. The context's
        // clock keeps following simulated time (below), so the game runs on unchanged; only a read of audio from past
        // the end says so (a play session never reads audio: no warning there)
        if (target >= len) { tap.dead = true; tap.full = true; tap.fullAt = audioClock.t; return; }
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
      while (capture && !tap.dead && tap.received < tap.rendered && real.now() < end) await new Promise((r) => real.setTimeout(r, 2));
    };
    sources.push(tap);
    return ctx;
  }
  WitnessAudioContext.prototype = Native.prototype;
  G.AudioContext = WitnessAudioContext;
  if (G.webkitAudioContext) G.webkitAudioContext = WitnessAudioContext;
}

async function renderAudio(ceil) {
  if (ceil) audioCeilSince = audioClock.since; else audioFloorSince = audioClock.since;   // also with no context yet
  for (const s of sources) if (s.render) await s.render(ceil);
}

async function readAudio() {
  if (CFG.audioCapture === false) warnOnce("audio-off", "audio capture is off in this session (a play session: WITNESS_CONFIG.audioCapture / ?witness_audio=0): audio reads are silent");
  await renderAudio(true);
  for (const s of sources) if (s.full) warnOnce("audio-full", `audio capture is full (${+CFG.audioSeconds || 300}s per AudioContext; set WITNESS_CONFIG.audioSeconds): later audio reads are silent`);
  for (const s of sources) if (s.settle) await s.settle();
  // no source yet: the rate a captured context would have, so a read before the game opens its audio (in the first
  // run) is as long as the same read once an earlier run's context exists (was 22050 vs 24000 Hz: 4410 vs 4800 frames)
  const rate = sources.length ? sources[0].rate : tapRate || 22050;
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
  /** A wheel's default action: scroll the nearest ancestor of el that can move by (dx, dy), else the page; instantly. */
  scrollBy(el, dx, dy) {
    const can = (e, d, axis) => {
      if (!d) return false;
      const cs = G.getComputedStyle(e), ov = axis === "y" ? cs.overflowY : cs.overflowX;
      if (!/(auto|scroll|overlay)/.test(ov)) return false;
      const pos = axis === "y" ? e.scrollTop : e.scrollLeft, max = axis === "y" ? e.scrollHeight - e.clientHeight : e.scrollWidth - e.clientWidth;
      return d > 0 ? pos < max - 0.5 : pos > 0.5;
    };
    const root = document.scrollingElement || document.documentElement;
    for (let e = el; e && e !== root && e !== document.body && e.nodeType === 1; e = e.parentElement) {
      if (can(e, dy, "y") || can(e, dx, "x")) { e.scrollBy({ left: Math.round(dx), top: Math.round(dy), behavior: "instant" }); return; }
      if (G.getComputedStyle(e).position === "fixed") break;   // a fixed bar: the wheel scrolls the page under it
    }
    // the page, unless its root clips that axis (html, or body when html is visible: overflow hidden|clip), as a browser
    const html = document.documentElement, body = document.body;
    const locked = (k) => { const h = G.getComputedStyle(html)[k]; return /^(hidden|clip)$/.test(h !== "visible" || !body ? h : G.getComputedStyle(body)[k]); };
    const px = locked("overflowX") ? 0 : Math.round(dx), py = locked("overflowY") ? 0 : Math.round(dy);
    if (px || py) G.scrollBy({ left: px, top: py, behavior: "instant" });
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
        // at the event's x, y when it has them (play's scroll order), else at the pointer
        const [cx, cy] = this.toClient(ev.x != null ? +ev.x : this.last[0], ev.y != null ? +ev.y : this.last[1]);
        const t = document.elementFromPoint(cx, cy) || this.canvases()[0] || document.body;
        const dx = +ev.dx || 0, dy = +ev.dy || 0;
        const go = t.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true, composed: true, view: G, ...this.mods() }));
        // a synthetic wheel event doesn't scroll anything: do the browser's default here (unless the page cancelled it),
        // at once and in whole pixels so a replay scrolls the same: the nearest ancestor that can scroll that way, else the page
        if (go) this.scrollBy(t, dx, dy);
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
  if (lazy.stale && lazy.redraw) { lazy.stale = false; try { lazy.redraw(); } catch (e) { reportError(e, "redraw before a screenshot"); } }
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
  // epoch: what Date.now() read when the recording began, so a replay's reset restarts the Date exactly there
  rec.header = { replay: 1, name: H.name || "game", seed: currentSeed, fps, epoch: clock.date(), started: new real.Date().toISOString() };
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
let busyNow = null;              // the command being handled: {cmd, name, t0, awaiting} (answered to "busy")
const asyncCalls = new Map();    // calls whose promise hasn't resolved yet
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
  return libs.length ? libs.join(" + ") : BROWSER ? (dom.canvases().length ? "browser (canvas)" : "browser (DOM)") : `node ${process.versions.node}`;
}

function hello() {
  const caps = ["step", "input", "snapshot", "eval", "logs", "perf"];
  if (H.reset) caps.unshift("reset");
  if (H.screenshot || BROWSER) caps.push("screenshot");
  if (H.audio || (CFG.audioCapture !== false && (sources.length || (BROWSER && G.OfflineAudioContext && CFG.webaudio !== false)))) caps.push("audio");
  if (H.calls && Object.keys(H.calls).length) caps.push("call");
  if (BROWSER) caps.push("reload");   // takes a reset with reloaded: true after the CLI reloaded the page (0.7.5+)
  const msg = { protocol: 1, name: H.name || (BROWSER ? document.title : "") || "game", engine: detectEngine(), language: H.language || "javascript", fps, capabilities: caps, adapter: `witness-js ${VERSION}`, witness: WITNESS_VERSION };
  const size = BROWSER ? dom.logicalSize() : H.size;
  if (Array.isArray(size)) msg.size = size.map((n) => Math.round(n));
  const calls = callsList();
  if (calls.length) msg.calls = calls;
  if (H.keys) msg.keys = H.keys;
  if (H.touch) msg.touch = true;      // the game handles touch itself: no mouse fallback for finger 0
  if (cfgEpoch != null) msg.epoch = cfgEpoch;   // the page's / env's own Date start (WITNESS_CONFIG.epoch, ?witness_epoch=, WITNESS_EPOCH)
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
  const lazyStep = m.draw === "last";   // every frame but the last runs with witness.drawing false
  const t0 = real.now();
  try {
    for (let i = 0; i < n; i++) {
      const dt = Array.isArray(m.dts) && +m.dts[i] > 0 ? +m.dts[i] : dflt;
      lazy.drawing = !lazyStep || i === n - 1;
      if (!lazy.drawing) lazy.skipped++;
      if (anim.pending) syncAnimations(false);   // started between frames and not caught yet: held at that time
      if (anim.flush) await renderingUpdate();   // their start events go out before the frame, as in every run
      applyInputs(sim.frame);
      if (anim.on && frameEvents.length && animMutated()) syncAnimations(false);   // one an input listener started: from the input's time
      runFrame(dt);
      if (sources.length) await renderAudio(false); else audioFloorSince = audioClock.since;
      if (endedQueue.size) fireEnded();   // sources that ended in what this frame rendered (see endedQueue)
      if (decoding.size) await decodesDone();   // a decodeAudioData the frame started is done by its end (see decoding)
      if (anim.flush) await renderingUpdate();
      sim.frame++;
      sim.time += dt;
      if (yieldEach) await macrotask();
    }
  } finally {
    // the last frame of every step is drawn, so a screenshot always follows a drawn frame; only a step that failed
    // part way (its error is the reply) can end on an undrawn one: the next screenshot redraws through witness.draw()
    lazy.stale = !lazy.drawing;
    lazy.drawing = true;
  }
  perfStats.frames = n;
  perfStats.ms = real.now() - t0;
  return { frame: sim.frame, time: sim.time };
}

async function doReset(m) {
  releaseAllInput();
  lazy.stale = false; lazy.drawing = true;   // a step that failed part way left an undrawn frame: the reset's own frame repaints, never the old draw()
  reseed(m.seed ?? 1);
  // an epoch with the reset (witness.json clock.epoch, or the replay's): Date restarts there exactly; without one the
  // Date goes on from where it was, lined up on a whole millisecond (what older replays were made with)
  const ep = epochMs(m.epoch);
  if (ep != null) { clock.epoch = ep; clock.dateBase = ep - clock.now(); } else clock.align();
  // the audio epoch first, so sounds the game's reset starts (music...) belong to the new run
  audioMark = audioEpoch = audioClock.t;
  const prevSince = audioClock.since;
  audioClock.since = 0;
  audioReadSince = 0;
  audioFloorSince = audioCeilSince = 0;
  // a reset starts silent: tails still ringing from the previous run must not leak into this one
  // (WebAudio nodes the game scheduled are its own: its reset should stop them)
  // a context the game closed before the reset never sounds again: leave it out (a game that opens a fresh context
  // per run would otherwise pile up 300 s offline contexts, the first of them setting the capture's rate)
  for (let i = sources.length - 1; i >= 0; i--) if (sources[i].closed && sources[i].closed()) sources.splice(i, 1);
  for (const s of sources) {
    s.read = 0;
    if (s.realign) await s.realign(prevSince);
    const a = epochIndex(s);
    if (s.clear) s.clear(a); else s.drop(a);
  }
  // m.reloaded: the CLI just reloaded the page for this reset (launch.reset "reload"): it is fresh, there is nothing
  // of a previous run to clear, so a game without a reset handler is fine
  if (H.reset) await H.reset({ seed: currentSeed, scene: m.scene, params: m.params || {} });
  // CSS animations / transitions still running restart at the reset: where they were depended on what ran before
  // (and on how many frames a page's boot took)
  if (anim.on) { anim.state = new WeakMap(); syncAnimations(); anim.flush = false; }
  sim.frame = 0;
  sim.time = 0;
  frameEvents = [];
  return {};
}

async function handle(m) {
  switch (m.cmd) {
    case "reset":
      if (!H.reset && !m.reloaded) throw new Error("this game has no reset handler (pass reset() to witness.start, or let the CLI reload the page: launch.reset \"reload\")");
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
      const r = fn(...(Array.isArray(m.args) ? m.args : []));
      if (!r || typeof r.then !== "function") { if (decoding.size) await decodesDone(); if (anim.on) await animSettle(); return { result: jsonSafe(r) ?? null }; }
      // a promise: named while unresolved (the "busy" query reports it)
      const key = {};
      asyncCalls.set(key, { name: String(m.name), t0: real.now() });
      if (busyNow) busyNow.awaiting = true;
      try { const v = await r; if (decoding.size) await decodesDone(); if (anim.on) await animSettle(); return { result: jsonSafe(v) ?? null }; } finally { asyncCalls.delete(key); }
    }
    case "eval": return { value: jsonSafe(await evaluate(String(m.expr))) ?? null };
    case "logs": return { logs: logs.splice(0) };
    case "perf": {
      const extra = H.perf ? jsonSafe(await H.perf()) : {};
      return { frame_ms: perfStats.frames ? perfStats.ms / perfStats.frames : 0, ...extra, counts: { raf_callbacks: sched.rafs.size, timers: sched.tasks.size, ...(extra && extra.counts) }, ...(rt.early ? { realtime: realtimeReport() } : {}), lazy_draw: { reads: lazy.reads, skipped: lazy.skipped, rng: rngCalls } };
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
  // "busy": answered at once, outside the queue (the CLI asks when a request timed out): what the page is still in
  if (m.cmd === "busy") {
    const t = real.now();
    try { conn && conn.send({ id: m.id, ok: true, busy: busyNow ? { cmd: busyNow.cmd, name: busyNow.name || null, ms: t - busyNow.t0, awaiting: !!busyNow.awaiting } : null, calls: [...asyncCalls.values()].map((c) => ({ name: c.name, ms: t - c.t0 })) }); } catch { /* gone */ }
    return;
  }
  rtHold();   // Witness drives the game until one macrotask after the reply (real-time activity, above)
  chain = chain.then(async () => {
    let reply;
    busyNow = { cmd: m.cmd, name: m.cmd === "call" ? String(m.name) : null, t0: real.now() };
    try { reply = { id: m.id, ok: true, ...(await handle(m)) }; }
    catch (e) { reply = { id: m.id, ok: false, error: e && e.message ? e.message : String(e) }; }
    busyNow = null;
    try { conn && conn.send(reply); } catch (e) { reportError(e, "sending a reply"); }
    rtRelease();
  });
}

function detach() {
  // Back to normal play if the game keeps running (attached sessions, or the CLI went away).
  rt.armed = rt.on = rt.idle = false;
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

// ------------------------------------------------------------------ page boot helpers (browser)

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => real.setTimeout(r, ms))]);

/**
 * Wait until the page's pictures and fonts are ready: every <img> and every CSS background-image url() decoded, and
 * document.fonts.ready; then `frames` real display frames (default 2) and `ms` more real milliseconds (default 0).
 * start() calls it in witness mode (start({ ready: false }) skips it, start({ ready: { ms: 300 } }) tunes it).
 * At most `timeout` ms (default 10000) for the decoding, and `each` ms (default 2500) for any one picture: WebKit's
 * HTMLImageElement.decode() can stay pending forever on some pictures (said once in the logs, then skipped).
 */
async function ready({ frames = 2, ms = 0, timeout = 10000, each = 2500 } = {}) {
  if (!BROWSER) return;
  const stuck = [];
  const dec = (im, u) => {
    if (!im.decode) return null;
    let done = false;
    return Promise.race([im.decode().catch(() => {}).then(() => { done = true; }), new Promise((r) => real.setTimeout(() => { if (!done) stuck.push(u); r(); }, each))]);
  };
  const work = (async () => {
    const urls = new Set();
    for (const img of Array.from(G.document.images || [])) if (img.currentSrc || img.src) urls.add(img.currentSrc || img.src);
    for (const el of Array.from(G.document.querySelectorAll("*"))) {
      let bg = "";
      try { bg = G.getComputedStyle(el).backgroundImage; } catch { /* detached */ }
      if (bg && bg !== "none") for (const m of bg.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) if (m[2]) urls.add(m[2]);
    }
    await Promise.all([...urls].map((u) => { const im = new G.Image(); im.src = u; return dec(im, u); }));
    await Promise.all(Array.from(G.document.images || []).map((img) => dec(img, img.currentSrc || img.src)));
    if (G.document.fonts && G.document.fonts.ready) await withTimeout(G.document.fonts.ready.catch(() => {}), each);
  })();
  const all = await Promise.race([work.then(() => true), new Promise((r) => real.setTimeout(() => r(false), timeout))]);
  if (stuck.length || !all) warnOnce("ready-decode", `start() ready: ${stuck.length ? `${stuck.length} picture(s) never finished decoding within ${each} ms (${[...new Set(stuck)].slice(0, 3).map((u) => String(u).split("/").pop().slice(0, 60)).join(", ")}${stuck.length > 3 ? ", …" : ""}; WebKit's decode() can hang)` : ""}${!all ? `${stuck.length ? "; " : ""}the whole wait was cut at ${timeout} ms` : ""}: went on`);
  for (let i = 0; i < frames; i++) await withTimeout(new Promise((r) => (real.requestAnimationFrame ? real.requestAnimationFrame(() => r()) : real.setTimeout(r, 16))), 100);
  if (ms > 0) await new Promise((r) => real.setTimeout(r, ms));
}

/**
 * Run the page's deferred classic scripts, in document order, now that the takeover is in place: every
 * <script type="text/witness"> (or any <script data-witness-deferred>) is replaced by a real classic script with the
 * same attributes and code (an src one is awaited until it has run; data-type="…" becomes its type). For pages whose
 * inline scripts would otherwise start their timers before witness.js is imported (GUIDE.md §1b; the CLI's
 * launch.inject is the other way). Module scripts run before DOMContentLoaded, so the scripts' own DOMContentLoaded
 * handlers still run. Returns how many scripts ran. Works in every mode (the page plays the same without Witness).
 */
async function boot({ selector = 'script[type="text/witness"], script[data-witness-deferred]' } = {}) {
  if (!BROWSER) return 0;
  let n = 0;
  for (const old of Array.from(G.document.querySelectorAll(selector))) {
    const el = G.document.createElement("script");
    for (const a of Array.from(old.attributes)) if (a.name !== "type" && a.name !== "data-witness-deferred" && a.name !== "data-type") el.setAttribute(a.name, a.value);
    const type = old.getAttribute("data-type");
    if (type) el.type = type;
    if (old.src) {
      el.async = false;
      const loaded = new Promise((r) => { el.onload = el.onerror = () => r(); });
      old.replaceWith(el);
      await loaded;
    } else {
      el.text = old.textContent;
      old.replaceWith(el);
    }
    n++;
  }
  return n;
}

// The text a reader sees under el: rendered text nodes, skipping aria-hidden / hidden subtrees (decorative minis,
// icon glyphs) and elements that aren't displayed; block elements and <br> break words apart.
function visibleText(el) {
  if (!el) return "";
  const out = [], cs = (e) => (G.getComputedStyle ? G.getComputedStyle(e) : null);
  const skip = (e) => e.getAttribute("aria-hidden") === "true" || e.hidden || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName) || (cs(e) && cs(e).display === "none");
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue); return; }
    if (n.nodeType !== 1 || skip(n)) return;
    if (n.tagName === "BR") { out.push(" "); return; }
    if (n.tagName === "INPUT" || n.tagName === "TEXTAREA") { if (n.value) out.push(` ${n.value} `); return; }
    const block = cs(n) && !/^inline/.test(cs(n).display);
    if (block) out.push(" ");
    for (const c of n.childNodes) walk(c);
    if (block) out.push(" ");
  };
  walk(el);
  return out.join("").replace(/\s+/g, " ").trim();
}

function describeEl(el, plain = false) {
  // the accessible name first (aria-label is what a screen reader says), then the visible text without decoration
  const aria = (el.getAttribute("aria-label") || "").trim(), text = aria ? "" : visibleText(el);
  const img = !aria && !text && el.querySelector ? el.querySelector("img[alt]") : null;
  const field = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type || ""));
  const label = field ? `${aria || el.getAttribute("placeholder") || (el.labels && el.labels[0] ? visibleText(el.labels[0]) : "") || el.name || "text"} [text field${el.value ? `: ${el.value}` : ""}]`
    : aria || text || el.getAttribute("title") || (img && img.alt) || (el.tagName === "IMG" && el.alt)
    || (el.tagName === "INPUT" && el.value ? String(el.value) : "") || (el.id ? `#${el.id}` : `<${el.tagName.toLowerCase()}>`);
  return plain ? label : `"${label}"`;
}

// DOM games: tap an element (touch-type pointer events, touch events on a touch device, compatibility mouse events,
// click; a user gesture for the audio policy), and list what can be tapped. Meant for the game's calls, so a replay
// repeats them:
//   witness.start({ calls: { tap: (sel) => witness.dom.tap(sel) }, snapshot: () => ({ choices: witness.dom.tappables() }) })
const TAP_HANDLERS = ["onclick", "onpointerdown", "onpointerup", "ontouchstart", "ontouchend", "onmousedown", "onmouseup"];
const TAP_NATIVE = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea';
// focusable by tabindex: a tap target unless it is a surface (a canvas the game taps by coordinates, media, a dialog / log / region)
const TAP_TABINDEX = '[tabindex]:not([tabindex="-1"]):not(canvas, video, audio, iframe, [role="dialog"], [role="alertdialog"], [role="log"], [role="region"], [role="document"], [role="application"], [role="main"], [role="tabpanel"])';
/** Selectors of the page's readable style rules that set cursor: pointer (active @media only; cross-origin sheets skipped),
 *  one per comma part; a part ending in * (.card, .card * {…}) is the inherit-it-anyway kind and left out. */
function pointerSelectors() {
  const out = [];
  const parts = (sel) => {   // split at top-level commas (not inside :is(a, b))
    const r = []; let depth = 0, from = 0;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (c === "(" || c === "[") depth++; else if (c === ")" || c === "]") depth--;
      else if (c === "," && !depth) { r.push(sel.slice(from, i)); from = i + 1; }
    }
    r.push(sel.slice(from));
    return r.map((s) => s.trim()).filter((s) => s && !/\*$/.test(s));
  };
  const walk = (rules) => {
    for (const r of rules) {
      if (r.media && r.media.mediaText && G.matchMedia && !G.matchMedia(r.media.mediaText).matches) continue;
      if (r.selectorText && r.style && r.style.cursor === "pointer") out.push(...parts(r.selectorText));
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const s of G.document.styleSheets) { try { if (!s.disabled) walk(s.cssRules); } catch { /* cross-origin: unreadable */ } }
  return out;
}
const TAP_POINTER_TAGS = new Set(["DIV", "SPAN", "LI", "IMG", "TD", "TH", "TR", "SECTION", "ARTICLE", "LABEL", "P", "FIGURE", "HEADER", "FOOTER", "NAV", "ASIDE", "svg", "H1", "H2", "H3", "H4", "H5", "H6"]);
/** A TouchEvent for dom.tap (one finger at cx, cy on target); an Event carrying the touch lists where the engine has no
 *  Touch / TouchEvent constructor (WebKit): handlers read e.touches / e.changedTouches the same. */
function tapTouchEvent(type, target, cx, cy, ends) {
  const t = { id: 0, target, cx, cy, force: ends ? 0 : 1 }, cur = ends ? [] : [t];
  const init = { bubbles: true, cancelable: true, composed: true, view: G };
  if (typeof G.TouchEvent === "function" && typeof G.Touch === "function") {
    const changed = dom.touchList([t]), touches = dom.touchList(cur);
    if (changed && touches) { try { return new TouchEvent(type, { ...init, touches, targetTouches: touches, changedTouches: changed }); } catch { /* below */ } }
  }
  const list = (l) => { const o = l.map((x) => ({ identifier: x.id, target, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pageX: cx + (G.scrollX || 0), pageY: cy + (G.scrollY || 0), radiusX: 0.5, radiusY: 0.5, rotationAngle: 0, force: x.force })); o.item = (i) => o[i] || null; return o; };
  let e;
  try { e = new (G.UIEvent || Event)(type, init); } catch { e = new Event(type, init); }
  const v = (value) => ({ value, enumerable: true });
  Object.defineProperties(e, { touches: v(list(cur)), targetTouches: v(list(cur)), changedTouches: v(list([t])), altKey: v(false), ctrlKey: v(false), metaKey: v(false), shiftKey: v(false) });
  return e;
}
const domHelpers = {
  /** Tap el (an Element or a CSS selector) at its centre. Returns "ok", or "blocked by <what is on top>" (warned).
   *  On a touch device (ontouchstart in window; or maxTouchPoints > 0 in an engine without TouchEvent: WebKit emulating one): pointerdown, touchstart, pointerup, touchend, then the
   *  compatibility mouse events and click unless the page cancelled touchstart / touchend (preventDefault), as a browser
   *  does; elsewhere pointer + mouse events and click. */
  tap(el) {
    if (!BROWSER) return "no page";
    const target = typeof el === "string" ? G.document.querySelector(el) : el;
    if (!target) return `not found: ${el}`;
    let r = target.getBoundingClientRect();
    if (r.bottom < 0 || r.top > G.innerHeight || r.right < 0 || r.left > G.innerWidth) { try { target.scrollIntoView({ block: "center", inline: "center" }); } catch { /* old engine */ } r = target.getBoundingClientRect(); }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = G.document.elementFromPoint(cx, cy);
    if (!hit || !(hit === target || target.contains(hit) || hit.contains(target))) {
      const what = !hit ? "nothing (off screen)" : hit.id ? `#${hit.id}` : describeEl(hit);
      warnOnce(`tap-blocked-${what}`, `dom.tap: ${describeEl(target)} is covered by ${what}`);
      return `blocked by ${what}`;
    }
    const base = { bubbles: true, cancelable: true, composed: true, view: G, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
    const p = { ...base, pointerId: TOUCH_POINTER_ID, pointerType: "touch", isPrimary: true, width: 1, height: 1 };
    const touch = "ontouchstart" in G || (G.navigator && G.navigator.maxTouchPoints > 0 && typeof G.TouchEvent !== "function");
    const focus = () => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && target.focus) target.focus(); };
    const w = webReg();
    gestureDepth++;
    if (w) w.begin();
    try {
      if (touch) {
        const send = (e) => { try { return hit.dispatchEvent(e); } catch (x) { warnOnce("tap-touch", `dom.tap: a touch event could not be sent (${x && x.message})`); return true; } };
        const down = G.PointerEvent ? hit.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1, pressure: 1 })) : true;
        const ts = send(tapTouchEvent("touchstart", hit, cx, cy, false));
        if (G.PointerEvent) hit.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0, pressure: 0 }));
        const te = send(tapTouchEvent("touchend", hit, cx, cy, true));
        if (!ts || !te) return "ok";   // the page took the touch: no mouse events, no click
        if (down) hit.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));   // pointerdown cancelled: no mouse events
        focus();
        if (down) hit.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
      } else {
        if (G.PointerEvent) hit.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1, pressure: 1 }));
        hit.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
        focus();
        if (G.PointerEvent) hit.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0, pressure: 0 }));
        hit.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
      }
      hit.dispatchEvent(new (G.PointerEvent || MouseEvent)("click", { ...p, buttons: 0 }));
    } finally { gestureDepth--; if (w) w.end(); }
    return "ok";
  },
  /** What can be tapped under root (an Element or a selector; default the document): [{label, id}], in view first;
   *  repeated labels get " #2". tappables({root?, elements: true}) (or tappables(root, {elements: true})) adds el, the
   *  element itself, for dom.tap(el). Found: buttons, links, fields, [role=button], [onclick], [tabindex] (not -1; not a
   *  canvas, media or a dialog / log / region), an element given an onclick / onpointerdown / ontouchstart… property in
   *  code, and one that sets cursor: pointer (by its own rule or inline style, not inherited from a pointer parent). A
   *  plain element holding other tappables (a delegating panel, a focusable dialog) gives way to them; nested
   *  buttons / links: the outer one. */
  tappables(root, opts) {
    if (!BROWSER) return [];
    if (root && typeof root === "object" && root.nodeType == null) { opts = root; root = root.root; }
    const elements = !!(opts && opts.elements);
    const scope = root ? (typeof root === "string" ? G.document.querySelector(root) : root) : G.document;
    if (!scope) return [];
    const native = new Set(scope.querySelectorAll(TAP_NATIVE)), found = new Set([...native, ...scope.querySelectorAll(`[onclick], ${TAP_TABINDEX}`)]);
    const html = G.document.documentElement, body = G.document.body;
    let ptrSel = null;   // computed style cannot tell inherited from set: a style rule (or inline style) that matches says it is set
    const setsPointer = (el) => el.style.cursor === "pointer" || (ptrSel ??= pointerSelectors()).some((s) => { try { return el.matches(s); } catch { return false; } });
    for (const el of scope.querySelectorAll("*")) {
      if (found.has(el) || el === html || el === body) continue;
      if (TAP_HANDLERS.some((h) => typeof el[h] === "function")) { found.add(el); continue; }
      if (TAP_POINTER_TAGS.has(el.tagName)) {
        const cs = G.getComputedStyle(el);
        // the element that sets cursor: pointer (its own rule: cards in a pointer hand), not children that inherit it
        if (cs.cursor === "pointer" && cs.display !== "none" && !(el.parentElement && G.getComputedStyle(el.parentElement).cursor === "pointer" && !setsPointer(el))) found.add(el);
      }
    }
    const els = [...found].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));   // document order
    const visible = (el) => {
      if (el.closest('[hidden], [aria-hidden="true"]') || el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = G.getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity !== 0;
    };
    const shown = els.filter(visible);
    const inner = shown.filter((el) => native.has(el) || !shown.some((o) => o !== el && el.contains(o)));   // a plain container gives way
    const kept = inner.filter((el) => !inner.some((o) => o !== el && o.contains(el)));   // nested tappables: the outer one
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < G.innerHeight && r.right > 0 && r.left < G.innerWidth ? 1 : 0; };
    kept.sort((a, b) => inView(b) - inView(a));   // stable: document order within each group
    const seen = new Map();
    return kept.map((el) => {
      let label = describeEl(el, true);
      if (el.classList.contains("sel") || el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true") label += " (selected)";
      label = label.slice(0, 56);
      const k = (seen.get(label) || 0) + 1;
      seen.set(label, k);
      if (k > 1) label = `${label.slice(0, 52)} #${k}`;
      return { label, id: el.id || null, ...(/\[text field(: .*)?\]$/.test(label) ? { input: true } : {}), ...(elements ? { el } : {}) };
    });
  },
  /** The visible text under root (an Element or a selector; default the body), aria-hidden / hidden parts left out: for
   *  state.screenText, so play testers read a panel as a player does. */
  text(root) {
    if (!BROWSER) return "";
    return visibleText(root ? (typeof root === "string" ? G.document.querySelector(root) : root) : G.document.body);
  },
};

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
  // pictures and fonts still decoding on real time would make the first screenshots differ from run to run
  if (BROWSER && options.ready !== false) await ready(isObj(options.ready) ? options.ready : {});
  try {
    conn = await connect(CFG.addr, onMessage, onClose);
  } catch (e) {
    started = false;
    if (real.console) real.console.error.call(G.console, `[witness] ${e.message}`);
    throw e;
  }
  pump = "step";              // from the hello on, frames run only on 'step'
  rt.armed = !!rt.early;      // watched for real-time activity (browser) from the first command's end on
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
  random: () => rand(),
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
  ready,
  boot,
  /** DOM games: dom.tap(elementOrSelector) -> "ok" | "blocked by …"; dom.tappables(root? | {root?, elements?}, opts?) -> [{label, id, input?, el?}]; dom.text(root?) -> string. */
  dom: domHelpers,
  /** Finite CSS / Web Animations still running (0 = settled): also globalThis.__witnessAnimating(). */
  animating: () => animatingCount(),
  get frame() { return sim.frame; },
  get time() { return sim.time; },
  /**
   * False while Witness runs a frame nobody will see (a step sent with "draw": "last": every frame but its last), true
   * otherwise (always outside witness mode). A loop does update(dt); if (witness.drawing !== false) draw(); the
   * simulation must not depend on drawing (doctor checks it when play.lazyDraw is on or the game reads this).
   */
  get drawing() { lazy.reads++; return lazy.drawing; },
  /** witness.draw(draw): call draw() unless this frame is skipped (returns whether it drew); also kept to repaint before a screenshot that follows an undrawn frame. */
  draw(fn) { if (typeof fn !== "function") return false; lazy.redraw = fn; lazy.reads++; if (!lazy.drawing) return false; fn(); return true; },
  /** The real (un-virtualized) timers and clocks, for code that must not be frozen. */
  real,
};

// ------------------------------------------------------------------ install (runs at import)

if (MODE === "witness") {
  Math.random = () => { if (rt.idle) rtNote("Math.random"); return rand(); };
  if (CFG.console !== false) captureConsole();
  captureErrors();
  if (BROWSER) {
    if (CFG.takeover !== false) installTakeover({ raf: CFG.raf !== false, timers: CFG.timers !== false });
    patchCanvasContexts();
    installVirtualGamepad();
    if (CFG.webaudio !== false) installWebAudioTap();
    if (sched.on && CFG.realtimeWatch !== false) installRealtimeWatch();
    // Until the hello, frames follow the display so the engine can boot and load, but each one
    // advances exactly 1/fps: engines that average recent dts (Phaser) then never hold odd values.
    if (sched.on && CFG.animations !== false && G.document && typeof G.document.getAnimations === "function") {
      anim.on = true;
      anim.videos = CFG.videos !== false;
      installAnimationCatch();
    }
    G.__witnessAnimating = () => animatingCount();
    if (sched.on) startRealPump(() => runFrame(1 / fps));
  } else if (CFG.takeover) {
    takeover({ raf: CFG.raf, timers: CFG.timers !== false });
  }
} else if (MODE === "record") {
  Math.random = () => rand();
  if (BROWSER) {
    if (CFG.takeover !== false) installTakeover({ raf: CFG.raf !== false, timers: CFG.timers !== false });
    installRecorderListeners();
    if (sched.on) startRealPump(realFrame);   // records once start() ran
  }
}

api.Mixer = Mixer;
return api;
}

const api = G.__witnessApi || (G.__witnessApi = createWitness());
// ---- module exports (cut off when the CLI injects this file as a classic script: src/core/browser.js)
export { api as witness };
export const start = api.start;
export const takeover = api.takeover;
export const recordFrame = api.recordFrame;
export const Mixer = api.Mixer;
export const mode = api.mode;
export const active = api.active;
export const seed = api.seed;
export const random = api.random;
export const log = api.log;
export const mark = api.mark;
export const sound = api.sound;
export const createMixer = api.createMixer;
export const ready = api.ready;
export const boot = api.boot;
export default api;
