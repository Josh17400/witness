// Web / WASM tests: `node tests/web/run.mjs` (also run by tests/run.mjs).
//   1. units (no browser): device profiles, canvas display maths, dom: input items, launch overrides
//   2. witness.h's web bridge compiled natively (WITNESS_WEB_BRIDGE + a stub emscripten.h) with the REAL
//      witness_emscripten.js running in Node: the coins sample (C and C++) through doctor and the shared test
//      (skipped without a C compiler)
//   3. browsers (skipped without Playwright; set WITNESS_PLAYWRIGHT, or `npm install` in examples/js-browser):
//      device profiles, device-pixel captures, the audio unlock policy, the Emscripten shim in a page
// One browser at a time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDevice, canvasDisplay, contextOptions, safeInsetsFor } from "../../src/core/devices.js";
import { parseWitnessInput } from "../../src/core/input-spec.js";
import { browserOptions } from "../../src/core/browser.js";
import { safePresetFor } from "../../src/cli/web.js";
import { encodePNG, decodePNG } from "../../src/media/png.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const cli = path.join(root, "bin", "witness.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, typeof extra === "string" ? extra.slice(-2500) : JSON.stringify(extra)); } };
const witness = (cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 240000, env: { ...process.env, ...env } });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

// ---- 1. units ----------------------------------------------------------------------------------------------------
{
  const d = resolveDevice("iphone-15");
  ok("device iphone-15", d.width === 393 && d.height === 852 && d.dpr === 3 && d.touch && d.mobile && d.standalone && /iPhone OS/.test(d.userAgent), d);
  const l = resolveDevice("iphone-15-landscape");
  ok("device landscape swaps the axes", l.width === 852 && l.height === 393 && l.landscape && l.name === "iphone-15-landscape", l);
  ok("device iphone-se is DPR 2", resolveDevice("iphone-se").dpr === 2 && resolveDevice("iphone-se").width === 375);
  ok("device ipad reports a Mac user agent (iPadOS desktop mode)", /Macintosh/.test(resolveDevice("ipad").userAgent) && resolveDevice("ipad").touch);
  // the Safari tab's landscape viewport is its own (toolbars differ), not the portrait one swapped; screen stays portrait
  const sl = resolveDevice("iphone-15-safari-landscape"), slo = contextOptions(sl);
  ok("iphone-15-safari-landscape: 734×343 CSS px (Playwright's iPhone 15 landscape), screen 393×852", sl.width === 734 && sl.height === 343 && slo.screen.width === 393 && slo.screen.height === 852, slo);
  ok("iphone-15-safari: screen 393×852, not the 659 px tall viewport", contextOptions(resolveDevice("iphone-15-safari")).screen.height === 852);
  ok("landscape profiles keep the portrait screen (iOS doesn't swap screen.width/height)", ["iphone-15-landscape", "iphone-se-landscape", "ipad-landscape", "iphone-15-pro-max-landscape"].every((n) => { const o = contextOptions(resolveDevice(n)); return o.screen.width < o.screen.height; }));
  ok("platform and touch points match the user agent: iPhone / MacIntel, 5", resolveDevice("iphone-15").platform === "iPhone" && resolveDevice("ipad").platform === "MacIntel" && resolveDevice("ipad").maxTouchPoints === 5 && resolveDevice("iphone-se").maxTouchPoints === 5);
  ok("doctor's safe-area preset per profile", safePresetFor(resolveDevice("iphone-15")) === "iphone-portrait" && safePresetFor(resolveDevice("iphone-15-landscape")) === "iphone-landscape" && safePresetFor(resolveDevice("iphone-15-safari")) === "iphone-safari-portrait" && safePresetFor(resolveDevice("iphone-15-pro-max")) === "iphone-max-portrait" && safePresetFor(resolveDevice("ipad-landscape")) === "ipad" && safePresetFor(null) === null);
  // --safe-insets: the measure ui --safe preset's numbers for the profile's orientation
  const si = (n) => { const v = safeInsetsFor(resolveDevice(n)); return v && [v.top, v.right, v.bottom, v.left].join(","); };
  ok("safe insets per profile: iPhone 15 portrait 59/34, landscape 59 left+right/21, Safari tab 0, SE 20 top, iPad 24/20", si("iphone-15") === "59,0,34,0" && si("iphone-15-landscape") === "0,59,21,59" && si("iphone-15-safari-landscape") === "0,0,0,0" && si("iphone-se") === "20,0,0,0" && si("ipad-landscape") === "24,0,20,0" && safeInsetsFor(null) === null);
  ok("--safe-insets needs a phone or tablet profile", (() => { try { browserOptions({ safeInsets: true }); return false; } catch (e) { return /need a phone or tablet profile/.test(e.message); } })() && browserOptions({ safeInsets: true, device: "iphone-15" }).safeInsets.top === 59);
  // witness_emscripten.js and witness.h's EM_JS bodies under emcc --closure 1: every name crossing the bundle's edge
  // is quoted (Closure ADVANCED renames dotted names: the hello rewrite and gesture marking would silently stop)
  {
    const strip = (t) => t.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    const edge = /(?<!\b(?:S|ws))\.(hello|capabilities|adapter|cmd|id|scale|addr|begin|end|inbuf|recv|heap|closed|canvas|WitnessEmscripten|WITNESS_CONFIG|__witnessWeb|WITNESS_ADDR|version|active|open|send|close|gesture|willReadFrequently|preserveDrawingBuffer)\b/g;
    const shim = strip(fs.readFileSync(path.join(root, "adapters", "cpp", "witness_emscripten.js"), "utf8"));
    const hits = [...shim.matchAll(edge)].map((m) => shim.slice(Math.max(0, m.index - 20), m.index + 16).replace(/\s+/g, " "));
    ok("closure-safe shim: no dotted access to names that cross the bundle's edge", hits.length === 0, hits);
    const emjs = (fs.readFileSync(path.join(root, "adapters", "cpp", "witness.h"), "utf8").match(/EM_JS\([\s\S]*?\n\}\);/g) || []).map(strip);
    ok("closure-safe EM_JS bodies in witness.h (5, all quoted)", emjs.length === 5 && emjs.every((b) => !edge.test(b) && /globalThis\[""\]/.test(b)), emjs);
  }
  // measure scale on a 1:1 gradient (nothing scaled): soft one-level steps are not blur, and not a ×3.2 grid
  {
    const tmpG = fs.mkdtempSync(path.join(os.tmpdir(), "witness-grad-"));
    const W = 320, H = 180, px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([20 + Math.round((x * 100) / 319), 40 + Math.round((y * 140) / 179), 200, 255], (y * W + x) * 4);
    fs.writeFileSync(path.join(tmpG, "grad.png"), encodePNG(W, H, px));
    const g = witness(tmpG, ["measure", "scale", "grad.png", "--json"]);
    const gj = json(g);
    ok("measure scale: a 1:1 gradient is 'no pixel grid larger than 1', ok (it said BLURRY 82.79%)", g.status === 0 && gj && gj.ok && gj.verdict === "no pixel grid larger than 1" && !gj.summary.blurry && !gj.summary.fractional, g.stdout + g.stderr);
    fs.rmSync(tmpG, { recursive: true, force: true });
  }
  // measure scale on a picture with two scales: a ×5 world, UI rows 115+ drawn at ×4.11 (device rows 473+)
  {
    const tmpM = fs.mkdtempSync(path.join(os.tmpdir(), "witness-mixed-"));
    const hash = (x, y, s) => { let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 7, 668265263) ^ Math.imul(s + 3, 2246822519); n = Math.imul(n ^ (n >>> 13), 1274126177); return (n ^ (n >>> 16)) >>> 0; };
    const PAL = [[20, 24, 46], [230, 57, 70], [241, 250, 238], [168, 218, 220], [69, 123, 157], [255, 183, 3]], UIP = [[250, 250, 250], [40, 40, 60], [200, 160, 40], [90, 200, 120]];
    const W = 1000, H = 600, px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const u = Math.floor(x / 4.11), v = Math.floor(y / 4.11); px.set([...(v >= 115 ? UIP[hash(u, v, 5) % 4] : PAL[hash(Math.floor(x / 5), Math.floor(y / 5), 2) % 6]), 255], (y * W + x) * 4); }
    fs.writeFileSync(path.join(tmpM, "mixed.png"), encodePNG(W, H, px));
    const a = witness(tmpM, ["measure", "scale", "mixed.png", "--layers", '[{"name":"hud","rect":[0,470,1000,130]}]', "--json"]);
    const aj = json(a);
    ok("measure scale: two scales in one picture: ×5 world 78.8% and hud ×4.11 21.2% (named by --layers), not one ×4.84 × 5 reading", aj && !aj.ok && aj.summary.regions.length === 2 && aj.summary.regions[0].scale.join() === "5,5" && aj.summary.regions[1].names[0] === "hud" && /^2 scales in one picture: ×5 \(whole, 78\.8% of the picture\) · hud ×4\.11 \(fractional, 21\.2%\)$/.test(aj.verdict) && JSON.stringify(aj.data.regions[1].rect) === '{"x":0,"y":473,"w":1000,"h":127}', a.stdout + a.stderr);
    const b = witness(tmpM, ["measure", "scale", "mixed.png", "--rect", "world=0,0,1000,473; ui=0,473,1000,127"]);
    ok("measure scale --rect: world exact ×5, ui FRACTIONAL ×4.11, read on their own", b.status === 1 && /✔ world \(0,0 1000×473\): exact ×5/.test(b.stdout) && /✖ ui \(0,473 1000×127\): FRACTIONAL ×4\.11: uneven: one source pixel is 4 or 5 px wide \(11% are 5\)/.test(b.stdout), b.stdout + b.stderr);
    fs.rmSync(tmpM, { recursive: true, force: true });
  }
  const c = resolveDevice({ width: 400, height: 300, dpr: 2.5, touch: true });
  ok("custom device", c.width === 400 && c.dpr === 2.5 && c.touch && !c.mobile && c.userAgent === null, c);
  let msg = "";
  try { resolveDevice("iphone-99"); } catch (e) { msg = e.message; }
  ok("unknown device names the choices", /iphone-15, .*ipad/.test(msg), msg);
  msg = "";
  try { resolveDevice({ width: 393.5, height: 852 }); } catch (e) { msg = e.message; }
  ok("custom device needs whole CSS pixels", /whole CSS pixels/.test(msg), msg);
  ok("no device: desktop viewport", JSON.stringify(contextOptions(null, [1280, 720])) === JSON.stringify({ viewport: { width: 1280, height: 720 } }));
  const co = contextOptions(d);
  ok("context options carry DPR, touch, mobile", co.deviceScaleFactor === 3 && co.hasTouch && co.isMobile && co.viewport.width === 393);
  ok("engine check", (() => { try { browserOptions({ engine: "safari" }); return false; } catch (e) { return /chromium .*webkit/.test(e.message); } })());
  ok("capture check", (() => { try { browserOptions({ capture: "gpu" }); return false; } catch (e) { return /canvas .*element .*screen/.test(e.message); } })());
  ok("firefox can't do a mobile viewport", (() => { try { browserOptions({ engine: "firefox", device: "iphone-15" }); return false; } catch (e) { return /Firefox/.test(e.message); } })());
  ok("policy from audioUnlock", browserOptions({ audioUnlock: false }).policy === "gesture" && browserOptions({}).policy === "auto");

  // canvas display: examples/js-browser on an iPhone 15: 320×180 canvas, box 361 CSS px wide (393 − 2×16 padding)
  const cd = canvasDisplay({ w: 320, h: 180, rect: [16, 60, 361, 203.0625], imageRendering: "pixelated" }, 3);
  ok("display: 361 CSS px at DPR 3 = 1083 device px = ×3.384375", cd.device[0] === 1083 && cd.device[1] === 609.1875 && cd.scale[0] === 3.3844 && cd.problem === "fractional" && !cd.integer, cd);
  const ci = canvasDisplay({ w: 320, h: 180, rect: [0, 0, 320, 180], imageRendering: "pixelated" }, 3);
  ok("display: 320 CSS px at DPR 3 = exact ×3, crisp", ci.integer && ci.scale[0] === 3 && ci.problem === null && /exact ×3/.test(ci.verdict), ci);
  const cb = canvasDisplay({ w: 393, h: 852, rect: [0, 0, 393, 852], imageRendering: "auto" }, 3);
  ok("display: CSS-size backing store at DPR 3 = ×3 smoothed = blurry (DPR blur)", cb.problem === "blurry" && /blurry/.test(cb.verdict), cb);
  const c1 = canvasDisplay({ w: 1179, h: 2556, rect: [0, 0, 393, 852], imageRendering: "auto" }, 3);
  ok("display: backing store at devicePixelRatio = 1:1, crisp", c1.integer && c1.scale[0] === 1 && c1.problem === null, c1);
  const co2 = canvasDisplay({ w: 320, h: 180, rect: [10.5, 0, 320, 180], imageRendering: "pixelated" }, 1);
  ok("display: half-pixel offset is reported", co2.problem === "offset" && co2.offset[0] === 10.5, co2);

  const evs = parseWitnessInput("dom:tap:80,45@0.5, dom:click:10,20@30f, dom:key:space@1, touch:1,2@1", 60);
  ok("dom: input items parse to frame-exact dom events", evs.filter((e) => e.type === "dom").map((e) => `${e.kind}@${e.frame}`).join(" ") === "tap@30 click@30 key@60" && evs.find((e) => e.kind === "tap").x === 80, evs);
  msg = "";
  try { parseWitnessInput("dom:swipe:1,2@1", 60); } catch (e) { msg = e.message; }
  ok("dom: unknown kind is refused", /dom: takes tap/.test(msg), msg);

  // command-line overrides need a browser launch
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-web-"));
  fs.writeFileSync(path.join(tmp, "witness.json"), JSON.stringify({ launch: { command: "game" } }));
  const r = witness(tmp, ["doctor", "--device", "iphone-15"]);
  ok("--device on a command launch is refused", r.status !== 0 && /for browser games/.test(r.stderr), r.stderr);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. the web bridge in witness.h, natively, with the real shim -------------------------------------------------
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "witness-bridge-"));
  const b = spawnSync(process.execPath, [path.join(here, "build-bridge.mjs"), out], { encoding: "utf8", timeout: 300000 });
  if (b.status === 2) console.log("  web bridge (native): skipped (no C compiler)");
  else if (typeof globalThis.WebSocket === "undefined") console.log(`  web bridge (native): built, run skipped (Node ${process.versions.node} has no global WebSocket for the shim; Node 22+)`);
  else {
    ok("web bridge compiles clean (C and C++, warnings as errors)", b.status === 0, b.stdout + b.stderr);
    const exes = (b.stdout || "").trim().split(/\r?\n/).filter((l) => fs.existsSync(l.trim())).map((l) => l.trim());
    for (const exe of b.status === 0 ? exes : []) {
      const proj = path.join(out, `proj-${path.basename(exe).replace(/\W/g, "")}`);
      fs.mkdirSync(path.join(proj, "witness"), { recursive: true });
      fs.copyFileSync(path.join(root, "examples", "cpp", "witness", "coins.witness.json"), path.join(proj, "witness", "coins.witness.json"));
      fs.writeFileSync(path.join(proj, "witness.json"), JSON.stringify({ name: "coins-web-bridge", launch: { command: process.execPath, args: [path.join(here, "bridge-node.mjs"), exe] }, tests: "witness", seed: 1, timeout: 30 }));
      const statsFile = path.join(proj, "stats.json");
      const d = witness(proj, ["doctor", "--json"], { BRIDGE_STATS: statsFile });
      const dj = json(d);
      ok(`bridge ${path.basename(exe)}: doctor all good and deterministic`, d.status === 0 && dj && dj.ok && dj.summary.deterministic === true, d.stdout + d.stderr);
      const st = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, "utf8")) : {};
      // the doctor's scripts hold 8 + 7 gesture inputs (key downs, mouse buttons; mouse moves aren't), run A twice: 23
      ok(`bridge ${path.basename(exe)}: 23 gestures marked around the input handler, never nested`, st.gestures === 23 && st.gestureDepthMax === 1, st);
      ok(`bridge ${path.basename(exe)}: hello passed through the shim`, st.hello && /witness\.h/.test(st.hello.adapter) && st.opened === 1, st);
      const t = witness(proj, ["test", "--repeat", "2"]);
      ok(`bridge ${path.basename(exe)}: shared coins test twice, identical`, t.status === 0 && /10 passed, 0 failed/.test(t.stdout) && /identical at every step/.test(t.stdout), t.stdout + t.stderr);
    }
  }
  fs.rmSync(out, { recursive: true, force: true });
}

// ---- 3. browsers ---------------------------------------------------------------------------------------------------
function findPlaywright() {
  for (const dir of [process.env.WITNESS_PLAYWRIGHT, path.join(root, "examples", "js-browser"), root].filter(Boolean)) {
    try { createRequire(path.join(dir, "package.json")).resolve("playwright"); return dir; } catch { /* next */ }
  }
  return null;
}
const pwDir = findPlaywright();
if (!pwDir) console.log("  browsers: skipped (no Playwright: npm install in examples/js-browser, or set WITNESS_PLAYWRIGHT)");
else {
  const env = { WITNESS_PLAYWRIGHT: pwDir };
  const P = (n) => path.join(here, "projects", n);
  const shots = [];
  // doctor on every correctly wired page: no "game code ran on real time between frames" (perf.realtime calls 0)
  const rtQuiet = [];

  // the Emscripten shim in a page: a JS stand-in for the compiled C side on a real WebAssembly.Memory
  let r = witness(P("bridge"), ["test", "--device", "iphone-15", "--no-auto-unlock"], env);
  ok("shim page: steps on command, heap growth, canvas readback, gesture resumes a native AudioContext", r.status === 0 && /2 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  shots.push(path.join(P("bridge"), "witness", "shots"));
  r = witness(P("bridge"), ["doctor", "--device", "iphone-15", "--no-auto-unlock", "--json"], env);
  let j = json(r);
  rtQuiet.push(["bridge, --device, iphone-15, --no-auto-unlock, --json", j]);
  ok("shim page: doctor deterministic, tap unlocks, screenshot answered by the shim", j && j.ok && j.summary.deterministic && j.summary.web.audioLocked === false && /screenshot 64×36/.test(j.data.lines.join("\n")), r.stdout + r.stderr);
  ok("shim page: 64 px canvas over 393 CSS px at DPR 3 = ×18.4219, fractional", j && j.summary.web.display.scale[0] === 18.4219 && j.summary.web.display.problem === "fractional" && j.summary.web.display.pixels.fractional, j && j.summary.web);

  // audio unlock: tap to start, done right and with the classic bug
  r = witness(P("unlock"), ["test", "--name", "witness tap"], env);
  ok("unlock: suspended until a Witness tap, running after it", r.status === 0 && /1 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  r = witness(P("unlock"), ["test", "--name", "real tap"], env);
  ok("unlock: the same with a trusted browser tap (dom:tap)", r.status === 0 && /1 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  r = witness(P("unlock"), ["test"], env);
  ok("unlock: a second unlock test in the same page is warned about", /already unlocked when this test began/.test(r.stdout), r.stdout);
  r = witness(P("unlock-bug"), ["doctor", "--no-auto-unlock", "--json"], env);
  j = json(r);
  rtQuiet.push(["unlock-bug, --no-auto-unlock, --json", j]);
  // the probe's tap and click each set the start flag, so the loop's resume() is blocked twice (more later in the doctor's runs)
  ok("unlock bug (resume() from the game loop): doctor warns, 2 resume() calls blocked in the probe", j && j.summary.web.audioLocked === true && j.summary.web.audio.state === "suspended" && /2 resume\(\) call\(s\) blocked/.test(j.summary.web.unlock), r.stdout + r.stderr);
  ok("unlock bug: 160×90 at 320×180 CSS px, DPR 3 = exact ×6, confirmed cell by cell", j && j.summary.web.display.scale[0] === 6 && j.summary.web.display.pixels.exact === true && j.summary.web.display.pixels.k === 6, j && j.summary.web.display);
  r = witness(P("unlock"), ["doctor", "--json"], env);
  j = json(r);
  rtQuiet.push(["unlock, --json", j]);
  ok("unlock done right: doctor's probe says a tap at the centre unlocked it at frame 4", j && j.summary.web.audioLocked === false && /running after a tap at the centre \(finger lifted at frame 4\)/.test(j.summary.web.unlock || ""), r.stdout + r.stderr);

  // a Fort-like sound engine: live voices counted down by onended (and by setTimeout), new sounds dropped at the cap,
  // a fresh context opened lazily after each reset through compressor ×2 + waveshaper + convolver. onended on the
  // virtual clock (never before the end, at most a frame + a quantum after), the capture's rate fixed before any
  // context exists (was 4410 vs 4800 frames), float noise within --audio-tol: every step repeats
  r = witness(P("voices"), ["test", "--repeat", "2"], env);
  ok("voices: test --repeat 2 identical at every step (onended voice cap, setTimeout voices, compressors + convolver, lazy context)", r.status === 0 && /4 passed, 0 failed/.test(r.stdout) && /identical at every step/.test(r.stdout) && !/lengths \d+ vs/.test(r.stdout), r.stdout + r.stderr);
  r = witness(P("voices"), ["doctor", "--json"], env);
  j = json(r);
  rtQuiet.push(["voices, --json", j]);
  ok("voices: doctor deterministic (state, screenshot and audio)", j && j.summary.deterministic === true && /✔ deterministic .*audio/.test(j.data.lines.join("\n")), r.stdout + r.stderr);

  // captured audio is silent while suspended and sounds after the tap (sample-exact, through the CLI's own modules)
  {
    const { findConfig, openGame } = await import(pathToFileURL(path.join(root, "src", "core", "launch.js")).href);
    const { begin, stepTo } = await import(pathToFileURL(path.join(root, "src", "core", "runner.js")).href);
    process.env.WITNESS_PLAYWRIGHT = pwDir;
    const f = findConfig(P("unlock"));
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session;
      const st = await begin(s, { seed: 1, input: "touch:80,45@0.5" });
      await s.audio();
      await stepTo(s, st, 15);
      const snapA = await s.snapshot();
      await stepTo(s, st, 30);
      const snapB = await s.snapshot();
      const before = new Float32Array(new Uint8Array(Buffer.from((await s.audio()).data, "base64")).buffer);
      await stepTo(s, st, 60);
      const snapC = await s.snapshot();
      const after = new Float32Array(new Uint8Array(Buffer.from((await s.audio()).data, "base64")).buffer);
      const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      ok("unlock: 0.5 s before the tap is exactly silent, the 0.5 s after it beeps", before.length === 12000 && peak(before) === 0 && peak(after) > 0.3, [before.length, peak(before), peak(after)]);
      // the suspended context is frozen, as in Safari: currentTime stays 0 and the 330 Hz jingle queued at the reset
      // (while locked) plays after the tap, from its start: 0.25 s of it in the 0.5 s after the tap
      const tone = (a, f, from, to) => { let re = 0, im = 0; for (let i = from; i < to; i++) { re += a[i] * Math.cos((2 * Math.PI * f * i) / 24000); im += a[i] * Math.sin((2 * Math.PI * f * i) / 24000); } return (2 * Math.hypot(re, im)) / (to - from); };
      const j330 = tone(after, 330, 0, 6000), j330late = tone(after, 330, 7200, 12000);
      ok("unlock: a jingle queued while suspended plays after the tap (330 Hz for 0.25 s), not used up silently", j330 > 0.3 && j330late < 0.02, [j330, j330late]);
      ok("unlock: a suspended context's currentTime stays 0 (frozen, as in Safari) and runs from the tap: ≈0.5 s at 1 s", snapA.state.audio === "suspended" && snapA.state.ct === 0 && snapB.state.ct === 0 && snapC.state.audio === "running" && snapC.state.ct > 0.45 && snapC.state.ct < 0.56, [snapA.state, snapB.state, snapC.state]);
    } finally { await g.stop(); }
  }

  // examples/js-browser on an iPhone 15: the 320×180 canvas lands on 1083×609.1875 device px (×3.384375)
  const ex = path.join(root, "examples", "js-browser");
  r = witness(ex, ["doctor", "--device", "iphone-15", "--json"], env);
  j = json(r);
  rtQuiet.push(["ex, --device, iphone-15, --json", j]);
  ok("coins on iphone-15: doctor all good", j && j.ok && j.summary.deterministic === true, r.stdout + r.stderr);
  ok("coins on iphone-15: display ×3.3844 fractional, measured from device pixels within 0.5%", j && j.summary.web.display.scale[0] === 3.3844 && j.summary.web.display.problem === "fractional"
    && j.summary.web.display.pixels.fractional && j.summary.web.display.pixels.agrees && Math.abs(j.summary.web.display.pixels.scale[0] - 3.384375) / 3.384375 < 0.005, j && j.summary.web);
  // the share of game pixels drawn 4 px wide is the layout's: 1083 = 3·320 + 123, 123/320 = 38.4%
  ok("coins on iphone-15: 38.4% of game pixels are 4 device px wide (from the layout)", j && /38\.4% of game pixels are 4 device px wide/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  ok("coins on iphone-15: the page says platform iPhone, 5 touch points, screen 393×852; safe areas named", j && /screen 393×852, maxTouchPoints 5/.test(j.data.lines.join("\n")) && /platform iPhone/.test(j.data.lines.join("\n")) && /safe areas are not emulated.*--safe iphone-portrait/.test(j.data.lines.join("\n")) && !/a real one reports 5/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  // iPhone SE (DPR 2): 343 CSS px = 686 device px = ×2.14375: the rounded border's 1-px runs made it ×1.67 × 1.58
  r = witness(ex, ["doctor", "--device", "iphone-se", "--json"], env);
  j = json(r);
  rtQuiet.push(["ex, --device, iphone-se, --json", j]);
  const sp = j && j.summary.web.display.pixels;
  ok("coins on iphone-se: layout ×2.1437, the picture agrees within 0.5%, 14.4% of game pixels 3 px wide", sp && j.summary.web.display.scale[0] === 2.1437 && sp.agrees && sp.fractional && Math.abs(sp.scale[0] - 686 / 320) / (686 / 320) < 0.005 && /14\.4% of game pixels are 3 device px wide/.test(j.data.lines.join("\n")) && !/✔ pixels on screen/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  const seShot = path.join(os.tmpdir(), `witness-web-se-${process.pid}.png`);
  r = witness(ex, ["shot", "--at", "1", "--device", "iphone-se", "--capture", "element", "--out", seShot], env);
  const ms = witness(ex, ["measure", "scale", seShot, "--json"]);
  j = json(ms);
  ok("coins on iphone-se: measure scale (no --region) says FRACTIONAL ≈×2.14, 2/3 px, 14% long", r.status === 0 && /686×\d+ device px: element capture/.test(r.stdout) && j && !j.ok && j.summary.fractional && Math.abs(j.summary.scaleX - 686 / 320) / (686 / 320) < 0.005 && j.data.runs.x.single.join() === "2,3" && Math.abs(j.data.runs.x.longShare - 0.14375) < 0.01, ms.stdout + ms.stderr);
  fs.rmSync(seShot, { force: true });
  r = witness(ex, ["shot", "--at", "1", "--device", "iphone-se", "--capture", "element", "--crop", "0,0,160,90", "--out", seShot], env);
  ok("--capture element with --crop: refused (game pixels vs device pixels)", r.status === 1 && /works in game pixels, but --capture element/.test(r.stderr) && !fs.existsSync(seShot), r.stdout + r.stderr);
  r = witness(ex, ["doctor", "--device", "ipad", "--json"], env);
  j = json(r);
  rtQuiet.push(["ex, --device, ipad, --json", j]);
  ok("coins on ipad: the page reports platform MacIntel and 5 touch points (the iPad check passes)", j && /screen 820×1180, maxTouchPoints 5/.test(j.data.lines.join("\n")) && /platform MacIntel/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  const shotFile = path.join(os.tmpdir(), `witness-web-shot-${process.pid}.png`);
  r = witness(ex, ["shot", "--at", "1", "--device", "iphone-15", "--capture", "element", "--out", shotFile], env);
  const m = witness(ex, ["measure", "scale", shotFile, "--region", "16,16,1051,577", "--json"]);
  j = json(m);
  ok("coins on iphone-15: shot --capture element is 1083 device px wide; measure scale says fractional ≈3.38", r.status === 0 && j && j.summary.fractional === true && j.ok === false
    && Math.abs(j.summary.scaleX - 3.384375) / 3.384375 < 0.02 && j.data.runs.x.single.join() === "3,4", m.stdout + m.stderr);
  fs.rmSync(shotFile, { force: true });
  r = witness(ex, ["test", "--device", "iphone-se"], env);
  ok("coins on iphone-se (DPR 2): shared test passes", r.status === 0 && /5 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);

  // a WebGL2 game that opens no audio in witness mode: doctor names the renderer and says there is nothing to unlock
  r = witness(P("gl"), ["doctor", "--no-auto-unlock", "--time", "1", "--json"], env);
  j = json(r);
  rtQuiet.push(["gl, --no-auto-unlock, --time, 1, --json", j]);
  ok("webgl: doctor reports the game's webgl2 canvas and Chromium's SwiftShader renderer (software)", j && j.ok && j.summary.web.webgl && j.summary.web.webgl.webgl2 === true && j.summary.web.webgl.canvasContext === "webgl2" && /SwiftShader/.test(j.summary.web.webgl.renderer) && j.summary.web.webgl.software === true && /✔ WebGL: the game's canvas draws with webgl2 · WebGL 2 · renderer ANGLE/.test(j.data.lines.join("\n")), r.stdout + r.stderr);
  ok("no AudioContext in witness mode: --no-auto-unlock says so and how to fix it (audioLocked null, not false)", j && j.summary.web.audioLocked === null && j.summary.web.noAudioContext === true && /no AudioContext was created .* open audio in witness mode too/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  r = witness(P("unlock"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  rtQuiet.push(["unlock, --time, 1, --json", j]);
  ok("a 2d canvas: the WebGL line is information only, naming the canvas's 2d context", j && j.summary.web.webgl && j.summary.web.webgl.canvasContext === "2d" && /^ {2}WebGL: WebGL 2 · renderer .* · the game's canvas uses 2d$/m.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));

  // safe areas: env(safe-area-inset-*) is 0 in a headless page; --safe-insets rewrites every use to the device's insets
  const safeState = (args) => { const e = witness(P("safe"), ["eval", "--at", "0.5", "state", "--json", ...args], env); const v = json(e); return v ? v.data.rows[0].values.state : { err: e.stdout + e.stderr }; };
  let st = safeState([]);
  ok("safe page without --safe-insets: env() is 0 (the HUD sits under the island)", st.hudLeft === "0px" && st.barHeight === "20px" && st.safe === null, st);
  st = safeState(["--safe-insets"]);
  ok("--safe-insets, landscape: <style> padding 59px, @media right 59px, <link> custom property 21px and calc() 41px, max() 59px, inline 59px, insertRule 21px", st.hudLeft === "59px" && st.hudTop === "0px" && st.cornerRight === "59px" && st.sab === "21px" && st.barHeight === "41px" && st.barPadRight === "59px" && st.inlLeft === "59px" && st.jsPad === "21px", st);
  const left59 = (s) => ["impLeft", "imp2Left", "nestLeft", "grpLeft", "namedLeft", "frameLeft", "shLeft"].every((k) => s[k] === "59px");
  ok("--safe-insets: @import (also from a <style> added by script), a 2-level fallback, insertRule into @media, rule.style.paddingLeft =, style.cssText every frame, a shadow root's <style>: all 59px", left59(st), st);
  ok("--safe-insets counts 15 distinct env() uses (the every-frame cssText once): 9 in style sheets, 2 inline (one added later), 4 from script; nothing missed; viewport-fit=cover", st.safe && st.safe.rewritten === 15 && st.safe.bySource.stylesheet === 9 && st.safe.bySource.inline === 2 && st.safe.bySource.script === 4 && st.safe.crossOrigin === 0 && st.safe.missed.count === 0 && st.safe.cover === true, st.safe);
  st = safeState(["--safe-insets", "--device", "iphone-15"]);
  ok("--safe-insets, portrait: top 59 (the fallback in env(..., 7px) unused), bottom 34, a later element's inline style 59px", st.hudTop === "59px" && st.hudLeft === "0px" && st.sab === "34px" && st.lateTop === "59px", st);
  r = witness(P("safe"), ["doctor", "--time", "0.5", "--safe-insets", "--json"], env);
  j = json(r);
  rtQuiet.push(["safe, --time, 0.5, --safe-insets, --json", j]);
  ok("doctor --safe-insets: says the insets were emulated and how many distinct env() uses were rewritten (15, not one per frame)", j && j.summary.web.safe && j.summary.web.safe.emulated && j.summary.web.safe.rewritten === 15 && j.summary.web.safe.rewrites > 15 && j.summary.web.safe.viewportFitCover === true && j.summary.web.safe.missed.count === 0 && /✔ safe areas emulated \(--safe-insets, iphone-landscape\): env\(safe-area-inset-\*\) = right 59 · bottom 21 · left 59 CSS px; 15 env\(\) uses in the page's CSS rewritten \(9 in style sheets, 2 inline, 4 set from script\)/.test(j.data.lines.join("\n")), r.stdout + r.stderr);
  ok("doctor --safe-insets: printed follow-up commands keep --safe-insets", j && /witness test --repeat 2 --safe-insets/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  // the same page without viewport-fit=cover (and a keyframe set by name from script, which Chromium can't rewrite)
  st = (() => { const e = witness(P("safe-nocover"), ["eval", "--at", "0.5", "state", "--json", "--safe-insets"], env); const v = json(e); return v ? v.data.rows[0].values.state : { err: e.stdout + e.stderr }; })();
  ok("no viewport-fit=cover: env() is 0 with --safe-insets too, as on the device", st.hudLeft === "0px" && st.barHeight === "20px" && st.impLeft === "0px" && st.safe && st.safe.cover === false && st.safe.rewritten === 15, st);
  r = witness(P("safe-nocover"), ["doctor", "--time", "0.5", "--safe-insets", "--json"], env);
  j = json(r);
  rtQuiet.push(["safe-nocover, --time, 0.5, --safe-insets, --json", j]);
  const nc = j ? j.data.lines.join("\n") : r.stdout + r.stderr;
  ok("doctor: no viewport-fit=cover is ⚠ (0 as on the device, letterboxed there), never ✔ emulated", j && j.summary.web.safe.viewportFitCover === false && /⚠ safe areas emulated \(--safe-insets, iphone-landscape\): the page has no viewport-fit=cover, so env\(safe-area-inset-\*\) is 0, as on the device, where the page is letterboxed inside the safe area/.test(nc) && /15 env\(\) uses in the page's CSS rewritten to 0/.test(nc) && !/✔ safe areas/.test(nc), nc);
  ok("doctor: a use Witness couldn't rewrite is ⚠ with where it is", j && j.summary.web.safe.missed.count === 1 && /⚠ 1 env\(safe-area-inset-\*\) use could not be rewritten and stays 0 here: @keyframes pulse 0% \(style sheet\)/.test(nc), nc);
  r = witness(P("safe"), ["doctor", "--time", "0.5", "--json"], env);
  j = json(r);
  rtQuiet.push(["safe, --time, 0.5, --json", j]);
  ok("doctor without it: not emulated, and names --safe-insets", j && !j.summary.web.safe && /safe areas are not emulated.*--safe-insets emulates them/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  // safe.html's inline classic script (a viewport tweak) ran before the module: a tip, not a warning
  ok("an inline classic script before the adapter, nothing on real time: doctor tips launch.inject (no ⚠)", j && /^ {2}tip: 1 inline classic <script> ran before witness\.js was imported: .*"launch": \{"inject": true\}/m.test(j.data.lines.join("\n")) && !/⚠ .*inline classic/.test(j.data.lines.join("\n")) && j.summary.web.realtime.earlyInlineScripts === 1, j && j.data.lines.join("\n"));
  // --safe-overlay: drawn over screenshots after capture (viewport capture at DPR 3, and the game's own 160×90 canvas)
  const ovFile = path.join(os.tmpdir(), `witness-web-ov-${process.pid}.png`);
  const px = (im, x, y) => Array.from(im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3)).join("/");
  r = witness(P("safe"), ["shot", "--at", "0.5", "--safe-overlay", "--capture", "screen", "--out", ovFile], env);
  let im = r.status === 0 ? decodePNG(fs.readFileSync(ovFile)) : null;
  // landscape: island 37×126 pt 11 pt from the left, centred (device x 33..144, y 400.5..778.5); indicator 134×5 pt 8 pt up;
  // the background #124 tinted 25% magenta in the left inset is 77/26/115
  ok("--safe-overlay (screen): black corner and island, light home indicator, magenta-tinted left inset, game untouched", im && px(im, 0, 0) === "0/0/0" && px(im, 90, 589) === "0/0/0" && px(im, 1278, 1147) === "235/235/235" && px(im, 160, 300) === "77/26/115" && px(im, 1000, 600) === "17/34/68", r.stdout + r.stderr + (im ? [px(im, 0, 0), px(im, 90, 589), px(im, 1278, 1147), px(im, 160, 300), px(im, 1000, 600)].join(" ") : ""));
  r = witness(P("safe"), ["shot", "--at", "0.5", "--safe-overlay", "--out", ovFile], env);
  im = r.status === 0 ? decodePNG(fs.readFileSync(ovFile)) : null;
  ok("--safe-overlay (the game's 160×90 canvas): the island mapped onto canvas pixels (5,45 black), centre untouched", im && im.width === 160 && px(im, 5, 45) === "0/0/0" && px(im, 80, 45) === "17/34/68" && px(im, 1, 20) === "77/26/115", r.stdout + r.stderr);
  fs.rmSync(ovFile, { force: true });

  // two scales in one picture (an SDL-style canvas at device resolution: world ×5, UI layer 622×287 stretched ×4.11)
  r = witness(P("mixed"), ["doctor", "--time", "0.5", "--scale-rect", "world=0,0,2556,940; ui=0,945,2556,234", "--json"], env);
  j = json(r);
  rtQuiet.push(["mixed, --time, 0.5, --scale-rect, world=0,0,2556,940; ui=0,945,2556,234, --json", j]);
  const mp = j && j.summary.web.display.pixels, mtxt = j ? j.data.lines.join("\n") : r.stdout + r.stderr;
  // UI rows 230+ of 287 start at device row 945 (pixel centres: 945.5 × 287 / 1179 = 230.2): 234 of 1179 rows = 19.8%
  ok("mixed scales: doctor reads world ×5 (whole, 80.2%) and ui ×4.11 (fractional, 19.8%), named from state.layers, not \"couldn't read\"", mp && mp.mixed && mp.regions.length === 2 && mp.regions[0].name === "world" && mp.regions[0].whole && mp.regions[0].scale.join() === "5,5" && mp.regions[1].name === "ui" && mp.regions[1].fractional && Math.abs(mp.regions[1].scale[0] - 2556 / 622) < 0.01 && /⚠ pixels on screen .*: 2 scales in one picture: world ×5 \(whole, 80\.2% of the picture\) · ui ×4\.11 \(fractional, 19\.8%\)/.test(mtxt) && !/couldn't read/.test(mtxt), mtxt);
  ok("mixed scales: the ui region is exactly 0,945 2556×234; the layout (×1) is said to be the canvas shown 1:1", mp && JSON.stringify(mp.regions[1].rect) === JSON.stringify({ x: 0, y: 945, w: 2556, h: 234 }) && /the canvas is shown 1:1 \(the layout's ×1\): these are the scales the game draws at itself/.test(mtxt), mtxt);
  ok("mixed scales: --scale-rect reads each rect: world exact ×5, ui FRACTIONAL ×4.11", mp && mp.rects.length === 2 && mp.rects[0].exact && mp.rects[1].fractional && /✔ --scale-rect world .*exact ×5/.test(mtxt) && /⚠ --scale-rect ui .*FRACTIONAL ×4\.11/.test(mtxt), mtxt);

  // WebKit (iPhone Safari's engine) when Playwright's build is installed
  r = witness(ex, ["doctor", "--engine", "webkit", "--device", "iphone-15", "--json"], env);
  j = json(r);
  rtQuiet.push(["ex, --engine, webkit, --device, iphone-15, --json", j]);
  if (!j && /isn't installed/.test(r.stderr)) ok("webkit missing: the error says how to install it", /npx playwright install webkit/.test(r.stderr), r.stderr);
  else {
    ok("coins in webkit on iphone-15: doctor deterministic", j && j.summary.deterministic === true && j.summary.web.engine === "webkit", r.stdout + r.stderr);
    ok("coins in webkit on iphone-15: maxTouchPoints 5 and platform iPhone (it said 0 and Win32)", j && /maxTouchPoints 5/.test(j.data.lines.join("\n")) && /platform iPhone/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
    r = witness(P("gl"), ["doctor", "--engine", "webkit", "--time", "1", "--json"], env);
    j = json(r);
    rtQuiet.push(["gl, --engine, webkit, --time, 1, --json", j]);
    ok("webgl in webkit (Windows build): WebGL 2 renders; the renderer is WebKit's generic \"Apple GPU\"", j && j.ok && j.summary.web.webgl.webgl2 === true && j.summary.web.webgl.renderer === "Apple GPU" && j.summary.web.webgl.canvasContext === "webgl2" && /WebKit's generic name/.test(j.data.lines.join("\n")), r.stdout + r.stderr);
    st = safeState(["--safe-insets", "--engine", "webkit"]);
    ok("--safe-insets in webkit: the same 15 rewrites and values (59px left, 41px bar, 21px var, @import, shadow root, …)", st.hudLeft === "59px" && st.barHeight === "41px" && st.sab === "21px" && st.inlLeft === "59px" && st.jsPad === "21px" && left59(st) && st.safe && st.safe.rewritten === 15 && st.safe.missed.count === 0, st);
    r = witness(P("bridge"), ["test", "--engine", "webkit", "--device", "iphone-15", "--no-auto-unlock"], env);
    ok("shim page in webkit: test passes", r.status === 0 && /2 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  }
  // real-time activity: a classic script's setInterval made before the adapter (loaded by a later import()) stays on
  // a real timer and draws between frames (The Fort's idleBake): doctor names its site; launch.inject puts it on the
  // virtual clock (no warning, deterministic)
  r = witness(P("realtime"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  let rtx = j ? j.data.lines.join("\n") : r.stdout + r.stderr;
  const rtr = j && j.summary.web && j.summary.web.realtime;
  ok("real-time interval before the adapter: doctor warns, with the site (realtime.html, idleBake) and the inject fix", rtr && rtr.calls > 0 && /^realtime\.html:\d+$/.test(rtr.first) && rtr.sites[0].fn === "idleBake" && /⚠ game code ran \d+ times? on real time between frames \(first at realtime\.html:\d+: (Math\.random|Canvas2D\.fillRect) in idleBake\) — a timer or listener made before Witness took over\? use "launch": \{"inject": true\} \(adapters\/js\/GUIDE\.md §1b\)/.test(rtx) && /idleBake \(realtime\.html:\d+:\d+\)/.test(rtx), rtx);
  ok("real-time interval: perf.realtime counts by kind (Math.random and Canvas2D.fillRect) and saw the inline classic script", rtr && /Math\.random ×\d+/.test(rtx) && /Canvas2D\.fillRect ×\d+/.test(rtx) && rtr.earlyInlineScripts === 1, rtr);
  r = witness(P("realtime-inject"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  rtQuiet.push(["realtime-inject", j]);
  rtx = j ? j.data.lines.join("\n") : r.stdout + r.stderr;
  ok("the same page with launch.inject: deterministic, no real-time warning, no inject tip", j && j.ok && j.summary.deterministic === true && j.summary.web.realtime && j.summary.web.realtime.calls === 0 && j.summary.web.realtime.earlyInlineScripts === 0 && !/real time between frames|inline classic/.test(rtx), rtx);
  {
    const loud = rtQuiet.filter(([, d]) => d && (/on real time between frames/.test(d.data.lines.join("\n")) || (d.summary.web && d.summary.web.realtime && d.summary.web.realtime.calls > 0)));   // no JSON: failed above
    ok(`no real-time warning on correctly wired pages (${rtQuiet.length} doctor runs)`, rtQuiet.length >= 10 && !loud.length, loud.map(([n, d]) => `${n}: ${d ? d.data.lines.filter((l) => /real time|    \S/.test(l)).join(" | ") : "no JSON"}`).join("\n"));
  }
  for (const n of ["realtime", "realtime-inject"]) fs.rmSync(path.join(P(n), "witness"), { recursive: true, force: true });

  // lazy drawing (step "draw": "last"): an expensive draw() gated by witness.drawing runs only on each step's last
  // frame; the state, the final picture and perf.lazy_draw say the rest is identical (draws counted, no timing)
  {
    const { findConfig, openGame } = await import(pathToFileURL(path.join(root, "src", "core", "launch.js")).href);
    const { begin, stepTo } = await import(pathToFileURL(path.join(root, "src", "core", "runner.js")).href);
    const f = findConfig(P("lazy"));
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session, draws = async () => (await s.call("draws", [])).result;
      const lz = async () => (await s.request("perf")).lazy_draw;
      let st = await begin(s, { seed: 1, input: "right@0-0.5, down@0.2-0.8" });
      const d0 = await draws(), p0 = await lz();
      for (let i = 0; i < 10; i++) await s.request("step", { frames: 6, draw: "last" });
      const dLazy = (await draws()) - d0, p1 = await lz();
      const a = await s.snapshot(), shotA = await s.screenshot();
      ok("lazy draw: 10 steps of 6 frames with draw:last → 10 draws, not 60 (frames 0-4 of each step skipped)", dLazy === 10 && a.frame === 60, { dLazy, frame: a.frame });
      ok("lazy draw: perf.lazy_draw counts 50 frames run undrawn and the game reading witness.drawing every frame", p1.skipped - p0.skipped === 50 && p1.reads - p0.reads >= 60, { p0, p1 });
      st = await begin(s, { seed: 1, input: "right@0-0.5, down@0.2-0.8" });
      const d1 = await draws();
      await stepTo(s, st, 60);
      const dFull = (await draws()) - d1;
      const b = await s.snapshot(), shotB = await s.screenshot();
      ok("lazy draw: the same run without the hint draws all 60 frames", dFull === 60, dFull);
      ok("lazy draw: identical state with and without the hint (x, y, t after 60 frames of input)", JSON.stringify(a.state) === JSON.stringify(b.state) && a.state.x > 40 && a.state.y > 45, [a.state, b.state]);
      ok("lazy draw: the final screenshot is fully drawn and pixel-identical to the unhinted run's", shotA.data === shotB.data && shotA.width === 160, [shotA.width, shotA.data === shotB.data]);
      const d2 = await draws();
      await s.request("step", { frames: 1, draw: "last" });
      await s.request("step", { frames: 5 });
      ok("lazy draw: a 1-frame hinted step draws its frame; a step without the hint draws every frame", (await draws()) - d2 === 6);
      ok("lazy draw: witness.drawing is true again between steps (read by eval)", (await s.eval("witness.drawing")).value === true);
    } finally { await g.stop(); }
  }
  // doctor: play.lazyDraw on → the extra run with the hint; safe page ✔, draw() mutating state ⚠, picture-only ⚠
  const dl = (d, rr) => (d ? d.data.lines.join("\n") : rr.stdout + rr.stderr);
  r = witness(P("lazy"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  ok("doctor, lazyDraw safe page: ✔ lazy drawing safe (same state and screenshot), summary.lazyDraw.safe", j && j.ok && j.summary.lazyDraw && j.summary.lazyDraw.safe && j.summary.lazyDraw.samePicture && j.summary.lazyDraw.reads > 0 && /^✔ lazy drawing safe: run A stepped 4 frames at a time with "draw": "last" \(45 of 60 frames undrawn\) ended in the same state, screenshot(, audio)?, random stream \(0 draws\)$/m.test(dl(j, r)) && !/not exercised/.test(dl(j, r)), dl(j, r));
  r = witness(P("lazy-bad"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  ok("doctor, draw() reads Math.random into state: ⚠ drawing changes game state: lazyDraw unsafe (deterministic otherwise)", j && j.summary.deterministic === true && j.summary.lazyDraw && j.summary.lazyDraw.safe === false && /⚠ drawing changes game state: lazyDraw unsafe for this game/.test(dl(j, r)) && /state differs from run A at \d+ path\(s\): state\.sparkle/.test(dl(j, r)), dl(j, r));
  r = witness(P("lazy-trail"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  ok("doctor, a trail drawn through witness.draw(): same state, ⚠ the picture differs", j && j.summary.lazyDraw && j.summary.lazyDraw.safe === true && j.summary.lazyDraw.samePicture === false && /⚠ lazy drawing changes the picture \(not the state\)/.test(dl(j, r)), dl(j, r));
  r = witness(P("lazy-rng"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  ok("doctor, draw() jitters with Math.random but stores nothing: same state, ⚠ draw() reads Math.random (45 fewer calls)", j && j.summary.deterministic === true && j.summary.lazyDraw && j.summary.lazyDraw.safe === false && JSON.stringify(j.summary.lazyDraw.rng) === "[60,15]" && /⚠ draw\(\) reads Math\.random \(45 fewer calls with the hint: 15 vs 60 in run A\): lazyDraw unsafe for this game/.test(dl(j, r)) && !/✔ lazy drawing safe/.test(dl(j, r)), dl(j, r));
  r = witness(P("lazy-sound"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  ok("doctor, draw() starts a sound: same state, ⚠ drawing changes game state/audio: lazyDraw unsafe", j && j.summary.deterministic === true && j.summary.lazyDraw && j.summary.lazyDraw.safe === false && /⚠ drawing changes game state\/audio: lazyDraw unsafe for this game/.test(dl(j, r)) && !/✔ lazy drawing safe/.test(dl(j, r)), dl(j, r));
  r = witness(P("lazy-menu"), ["doctor", "--time", "1", "--json"], env);
  j = json(r);
  ok("doctor, a game that draws only past a menu doctor's reset doesn't leave: ⚠ lazy drawing not exercised, safe null (no ✔)", j && j.summary.lazyDraw && j.summary.lazyDraw.safe === null && j.summary.lazyDraw.reads === 0 && /⚠ lazy drawing not exercised: the game never asked witness\.drawing during doctor's scripted run/.test(dl(j, r)) && !/✔ lazy drawing safe/.test(dl(j, r)), dl(j, r));
  r = witness(P("lazy-menu"), ["doctor", "--time", "1", "--params", '{"run":true}', "--json"], env);
  j = json(r);
  ok("doctor --params '{\"run\":true}' reaches the drawing scene: ✔ lazy drawing safe", j && j.summary.lazyDraw && j.summary.lazyDraw.safe === true && j.summary.lazyDraw.reads > 0 && /✔ lazy drawing safe/.test(dl(j, r)) && !/not exercised/.test(dl(j, r)), dl(j, r));
  for (const n of ["lazy", "lazy-bad", "lazy-trail", "lazy-rng", "lazy-sound", "lazy-menu"]) fs.rmSync(path.join(P(n), "witness"), { recursive: true, force: true });

  // a pure-DOM page: CSS animations on the virtual clock, launch.inject, witness.boot(), reset by reload, clock.epoch
  {
    const d = spawnSync(process.execPath, [path.join(here, "dom.mjs")], { encoding: "utf8", timeout: 900000, env: { ...process.env, ...env } });
    const m = /(\d+) passed, (\d+) failed/.exec(d.stdout || "");
    if (m) pass += +m[1];
    ok("dom page suite (tests/web/dom.mjs)", d.status === 0 && m && +m[2] === 0, d.stdout + d.stderr);
  }
  // launch.media, desktop dom:tap, call timeout, hanging decode(), a temp-folder config, play sessions without audio capture
  {
    const d = spawnSync(process.execPath, [path.join(here, "media.mjs")], { encoding: "utf8", timeout: 600000, env: { ...process.env, ...env } });
    const m = /(\d+) passed, (\d+) failed/.exec(d.stdout || "");
    if (m) pass += +m[1];
    ok("media page suite (tests/web/media.mjs)", d.status === 0 && m && +m[2] === 0, d.stdout + d.stderr);
  }
  for (const d of shots) fs.rmSync(d, { recursive: true, force: true });
  for (const n of ["bridge", "unlock", "unlock-bug", "gl", "safe", "safe-nocover", "mixed", "voices"]) fs.rmSync(path.join(P(n), "witness", "shots"), { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
