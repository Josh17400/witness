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
      await stepTo(s, st, 30);
      const before = new Float32Array(new Uint8Array(Buffer.from((await s.audio()).data, "base64")).buffer);
      await stepTo(s, st, 60);
      const after = new Float32Array(new Uint8Array(Buffer.from((await s.audio()).data, "base64")).buffer);
      const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      ok("unlock: 0.5 s before the tap is exactly silent, the 0.5 s after it beeps", before.length === 12000 && peak(before) === 0 && peak(after) > 0.3, [before.length, peak(before), peak(after)]);
    } finally { await g.stop(); }
  }

  // examples/js-browser on an iPhone 15: the 320×180 canvas lands on 1083×609.1875 device px (×3.384375)
  const ex = path.join(root, "examples", "js-browser");
  r = witness(ex, ["doctor", "--device", "iphone-15", "--json"], env);
  j = json(r);
  ok("coins on iphone-15: doctor all good", j && j.ok && j.summary.deterministic === true, r.stdout + r.stderr);
  ok("coins on iphone-15: display ×3.3844 fractional, measured from device pixels within 2%", j && j.summary.web.display.scale[0] === 3.3844 && j.summary.web.display.problem === "fractional"
    && j.summary.web.display.pixels.fractional && Math.abs(j.summary.web.display.pixels.scale[0] - 3.384375) / 3.384375 < 0.02, j && j.summary.web);
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
    r = witness(P("bridge"), ["test", "--engine", "webkit", "--device", "iphone-15", "--no-auto-unlock"], env);
    ok("shim page in webkit: test passes", r.status === 0 && /2 passed, 0 failed/.test(r.stdout), r.stdout + r.stderr);
  }
  for (const d of shots) fs.rmSync(d, { recursive: true, force: true });
  for (const n of ["bridge", "unlock", "unlock-bug"]) fs.rmSync(path.join(P(n), "witness", "shots"), { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
