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
import { resolveDevice, canvasDisplay, contextOptions } from "../../src/core/devices.js";
import { parseWitnessInput } from "../../src/core/input-spec.js";
import { browserOptions } from "../../src/core/browser.js";
import { safePresetFor } from "../../src/cli/web.js";
import { encodePNG } from "../../src/media/png.js";

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

  // the Emscripten shim in a page: a JS stand-in for the compiled C side on a real WebAssembly.Memory
  let r = witness(P("bridge"), ["test", "--device", "iphone-15", "--no-auto-unlock"], env);
  ok("shim page: steps on command, heap growth, canvas readback, gesture resumes a native AudioContext", r.status === 0 && /2 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  shots.push(path.join(P("bridge"), "witness", "shots"));
  r = witness(P("bridge"), ["doctor", "--device", "iphone-15", "--no-auto-unlock", "--json"], env);
  let j = json(r);
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
  // the probe's tap and click each set the start flag, so the loop's resume() is blocked twice (more later in the doctor's runs)
  ok("unlock bug (resume() from the game loop): doctor warns, 2 resume() calls blocked in the probe", j && j.summary.web.audioLocked === true && j.summary.web.audio.state === "suspended" && /2 resume\(\) call\(s\) blocked/.test(j.summary.web.unlock), r.stdout + r.stderr);
  ok("unlock bug: 160×90 at 320×180 CSS px, DPR 3 = exact ×6, confirmed cell by cell", j && j.summary.web.display.scale[0] === 6 && j.summary.web.display.pixels.exact === true && j.summary.web.display.pixels.k === 6, j && j.summary.web.display);
  r = witness(P("unlock"), ["doctor", "--json"], env);
  j = json(r);
  ok("unlock done right: doctor's probe says a tap at the centre unlocked it at frame 4", j && j.summary.web.audioLocked === false && /running after a tap at the centre \(finger lifted at frame 4\)/.test(j.summary.web.unlock || ""), r.stdout + r.stderr);

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
  ok("coins on iphone-15: doctor all good", j && j.ok && j.summary.deterministic === true, r.stdout + r.stderr);
  ok("coins on iphone-15: display ×3.3844 fractional, measured from device pixels within 0.5%", j && j.summary.web.display.scale[0] === 3.3844 && j.summary.web.display.problem === "fractional"
    && j.summary.web.display.pixels.fractional && j.summary.web.display.pixels.agrees && Math.abs(j.summary.web.display.pixels.scale[0] - 3.384375) / 3.384375 < 0.005, j && j.summary.web);
  // the share of game pixels drawn 4 px wide is the layout's: 1083 = 3·320 + 123, 123/320 = 38.4%
  ok("coins on iphone-15: 38.4% of game pixels are 4 device px wide (from the layout)", j && /38\.4% of game pixels are 4 device px wide/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  ok("coins on iphone-15: the page says platform iPhone, 5 touch points, screen 393×852; safe areas named", j && /screen 393×852, maxTouchPoints 5/.test(j.data.lines.join("\n")) && /platform iPhone/.test(j.data.lines.join("\n")) && /safe areas are not emulated.*--safe iphone-portrait/.test(j.data.lines.join("\n")) && !/a real one reports 5/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
  // iPhone SE (DPR 2): 343 CSS px = 686 device px = ×2.14375: the rounded border's 1-px runs made it ×1.67 × 1.58
  r = witness(ex, ["doctor", "--device", "iphone-se", "--json"], env);
  j = json(r);
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

  // WebKit (iPhone Safari's engine) when Playwright's build is installed
  r = witness(ex, ["doctor", "--engine", "webkit", "--device", "iphone-15", "--json"], env);
  j = json(r);
  if (!j && /isn't installed/.test(r.stderr)) ok("webkit missing: the error says how to install it", /npx playwright install webkit/.test(r.stderr), r.stderr);
  else {
    ok("coins in webkit on iphone-15: doctor deterministic", j && j.summary.deterministic === true && j.summary.web.engine === "webkit", r.stdout + r.stderr);
    ok("coins in webkit on iphone-15: maxTouchPoints 5 and platform iPhone (it said 0 and Win32)", j && /maxTouchPoints 5/.test(j.data.lines.join("\n")) && /platform iPhone/.test(j.data.lines.join("\n")), j && j.data.lines.join("\n"));
    r = witness(P("bridge"), ["test", "--engine", "webkit", "--device", "iphone-15", "--no-auto-unlock"], env);
    ok("shim page in webkit: test passes", r.status === 0 && /2 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  }
  for (const d of shots) fs.rmSync(d, { recursive: true, force: true });
  for (const n of ["bridge", "unlock", "unlock-bug"]) fs.rmSync(path.join(P(n), "witness", "shots"), { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
