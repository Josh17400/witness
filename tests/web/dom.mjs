// A pure-DOM page (no canvas) through the JS adapter: CSS transitions / animations on the virtual clock (screenshots
// reproducible mid-transition, end events still fire, __witnessAnimating() counts down), the adapter injected before
// an inline classic script (launch.inject), dom: input on the real-time watch, a page reload for reset (launch.reset), the clock epoch (clock.epoch),
// "browser (DOM)" and the viewport capture. Run: node tests/web/dom.mjs (also run by tests/web/run.mjs).
// Needs Playwright (WITNESS_PLAYWRIGHT, or npm install in examples/js-browser); one browser at a time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePNG } from "../../src/media/png.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const cli = path.join(root, "bin", "witness.js");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, typeof extra === "string" ? extra.slice(-2500) : JSON.stringify(extra)); } };

// units (no browser): the epoch resolution
const { resolveEpoch } = await import(pathToFileURL(path.join(root, "src", "core", "launch.js")).href);
{
  ok("clock.epoch: an ISO date is 00:00 UTC that day", resolveEpoch({ clock: { epoch: "2026-06-15" } }) === Date.UTC(2026, 5, 15));
  ok("clock.epoch: a full ISO time", resolveEpoch({ clock: { epoch: "2026-06-15T09:30:00Z" } }) === Date.UTC(2026, 5, 15, 9, 30));
  const d = new Date(), cfg = { clock: { epoch: "today" } };
  ok("clock.epoch: today = this run's date, pinned (the same value on every call for the config)", resolveEpoch(cfg) === Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) && resolveEpoch(cfg) === resolveEpoch(cfg));
  ok("clock.epoch: none = the adapter's default (null)", resolveEpoch({}) === null);
  let msg = "";
  try { resolveEpoch({ clock: { epoch: "next tuesday" } }); } catch (e) { msg = e.message; }
  ok("clock.epoch: a bad date is refused", /isn't a date/.test(msg), msg);
}

function findPlaywright() {
  for (const dir of [process.env.WITNESS_PLAYWRIGHT, path.join(root, "examples", "js-browser"), root].filter(Boolean)) {
    try { createRequire(path.join(dir, "package.json")).resolve("playwright"); return dir; } catch { /* next */ }
  }
  return null;
}
const pwDir = findPlaywright();
if (!pwDir) console.log("  dom page: browser part skipped (no Playwright)");
else {
  process.env.WITNESS_PLAYWRIGHT = pwDir;
  const P = (n) => path.join(here, "projects", n);
  const { findConfig, openGame } = await import(pathToFileURL(path.join(root, "src", "core", "launch.js")).href);
  const { begin, stepTo, queueInput, runTest } = await import(pathToFileURL(path.join(root, "src", "core", "runner.js")).href);
  const shotOf = async (s) => { const r = await s.screenshot(); return decodePNG(Buffer.from(r.data, "base64")); };
  const px = (im, x, y) => Array.from(im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3));
  const same = (a, b) => a && b && a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;

  // 1. launch.inject + clock.epoch + reload reset, in one browser
  {
    const f = findConfig(P("dom"));
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session, epoch = Date.UTC(2026, 5, 15);
      ok("DOM page: hello says browser (DOM); the CLI captures the viewport; reset by reload (no reset handler)", s.hello.engine === "browser (DOM)" && s.web.captureMode === "screen" && s.web.domPage === true && typeof s.web.dom === "function" && s.web.resetMode === "reload" && s.has("reset"), [s.hello.engine, s.web.captureMode, s.web.resetMode]);
      let st = await begin(s, { seed: 1 });
      await stepTo(s, st, 18);
      let a = (await s.snapshot()).state;
      ok("inject: the inline classic script's boot timer ran on the virtual clock (performance.now() exactly 200 at 200 ms)", a.booted === true && a.bootAt === 200, a);
      ok("clock.epoch: Date starts at 2026-06-15 at the reset (0.3 s in)", a.now - epoch >= 290 && a.now - epoch <= 300 && a.count === "Resets in 7d", [a.now - epoch, a.count]);
      ok("dom.tappables: a page with no buttons lists none", Array.isArray(a.choices) && a.choices.length === 0, a.choices);
      await s.call("move");
      await stepTo(s, st, 18 + 30);
      a = (await s.snapshot()).state;
      const ev = await s.eval("globalThis.__witnessAnimating?.() ?? 0");
      ok("__witnessAnimating: 2 transitions (transform, colour) and the keyframe animation are running (the infinite spinner isn't counted)", a.animating === 3 && ev.value === 3, [a.animating, ev.value]);
      const shotA = await shotOf(s);
      // 0.5 s into a 1 s linear 200 px move: the card's left edge is at 120 px; its colour halfway red → green
      const mid = px(shotA, 125, 80), start = px(shotA, 30, 80);
      ok("mid-transition screenshot: the card is half way (x 120..200) and half way to green, not the end state", mid[0] > 100 && mid[0] < 170 && mid[1] > 100 && mid[1] < 170 && start.join() === "17,34,51", [mid, start]);
      const counts = [];
      for (let f2 = 48; f2 <= 18 + 70; f2 += 5) { await stepTo(s, st, f2); counts.push((await s.eval("globalThis.__witnessAnimating?.() ?? 0")).value); }
      a = (await s.snapshot()).state;
      ok("__witnessAnimating counts down to 0 (bar ends at 0.5 s, card at 1 s) and both end events fired", counts[0] === 3 && counts.includes(2) && counts[counts.length - 1] === 0 && a.ends === 2, [counts, a.ends]);
      const endShot = await shotOf(s);
      ok("after the transition: the card is at 220 px and green", px(endShot, 225, 80)[1] > 200 && px(endShot, 125, 80).join() === "17,34,51", [px(endShot, 225, 80), px(endShot, 125, 80)]);
      ok("in-memory progress: 1 tap, saved to localStorage", a.taps === 1, a);

      // a second run: reset reloads the page (fresh memory, storage cleared), and the same inputs give the same pixels
      st = await begin(s, { seed: 1 });
      await stepTo(s, st, 18);
      a = (await s.snapshot()).state;
      ok("reset reload: memory and storage start fresh (0 taps, nothing saved), Date back at the epoch", a.taps === 0 && a.saved === null && a.ends === 0 && a.now - epoch <= 300 && s.web.reloads === 1, [a, s.web.reloads]);
      await s.call("move");
      await stepTo(s, st, 18 + 30);
      const shotB = await shotOf(s);
      ok("screenshots reproducible across two runs mid-transition (byte-identical pixels)", same(shotA, shotB), [px(shotA, 125, 80), px(shotB, 125, 80)]);
      // reset again right away: the page reloads only when something ran since the last load
      st = await begin(s, { seed: 2 });
      st = await begin(s, { seed: 3 });
      ok("a reset right after a reload doesn't reload again", s.web.reloads === 2, s.web.reloads);
      // test steps on the page (0.7.8): expectPage / evalAs in the game, until (+ untilPage) after a call, a per-test epoch
      const july = Date.UTC(2026, 6, 1);
      const rt = await runTest(s, { name: "page", file: "dom.witness.json", index: 0, epoch: "2026-07-01", steps: [
        { at: 0.3, expectPage: ["document.querySelectorAll('#card').length == 1", "document.querySelectorAll('#card.moved').length"], evalAs: { divs: "document.querySelectorAll('div').length" }, expect: ["divs == 4", `state.now - ${july} <= 300 && state.now >= ${july}`] },
        { call: ["move"], until: "state.ends >= 2", untilPage: "document.querySelector('#card').classList.contains('moved')", timeout: 3, expect: "state.taps == 1" },
        { after: 0.1, expectPage: "game.ends == 2 && game.taps == 1" },
      ] });
      const fm = rt.failures.filter((x) => x.kind !== "warn").map((x) => x.message);
      ok("page test steps: expectPage runs in the page (a failing one says 'got 0'), evalAs feeds expects, until met when both transitions ended (~1 s after the call), a per-test epoch", rt.expects.passed === 6 && rt.expects.failed === 1 && fm.length === 1 && /page document\.querySelectorAll\('#card\.moved'\)\.length — got 0/.test(fm[0]) && rt.untils && rt.untils[0].frame >= 75 && rt.untils[0].frame <= 82 && rt.epoch === july && s.epoch === epoch, JSON.stringify({ e: rt.expects, f: rt.failures, u: rt.untils, ep: s.epoch }));
    } finally { await g.stop(); }
  }

  // 2. the same page without launch.inject: the classic script ran before witness.js was imported (real-time boot
  //    timer), and the default epoch; reset "handler" keeps the old refusal for a game without a reset handler
  {
    const f = findConfig(P("dom-plain"));
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session;
      ok("reset handler-only: a game without a handler has no reset capability", !s.has("reset"), s.hello.capabilities);
      const st = await begin(s, { seed: 1 });
      await stepTo(s, st, 30);
      const a = (await s.snapshot()).state;
      ok("without clock.epoch: Date from the default epoch (2026-01-01)", a.now >= Date.UTC(2026, 0, 1) && a.now < Date.UTC(2026, 0, 1) + 60000, a);
    } finally { await g.stop(); }
  }

  // 2b. witness.boot(): deferred classic scripts (type="text/witness") run after the import, in order, on the virtual clock
  {
    const f = findConfig(P("dom-boot"));
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session;
      const st = await begin(s, { seed: 1 });
      await stepTo(s, st, 30);
      const a = (await s.snapshot()).state;
      ok("witness.boot(): deferred scripts ran in order, their timer on the virtual clock (200 exactly), DOMContentLoaded still reached them", a.bootAt === 200 && a.order.join() === "a,b" && a.ready === true, a);
    } finally { await g.stop(); }
  }

  // 2c. real-time watch: the CLI's dom:click is driven input, boundary events (mouseover / pointerenter, before the
  // move) included; an inline classic script that only sets window.WITNESS_CONFIG is not an early script
  {
    const f = findConfig(P("hover"));
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session;
      const st = await begin(s, { seed: 1 });
      await queueInput(s, st, [{ frame: 12, type: "dom", kind: "click", x: 80, y: 45 }]);
      await stepTo(s, st, 30);
      await new Promise((r) => setTimeout(r, 300));   // let any late compatibility events land while Witness is idle
      const a = (await s.snapshot()).state, rtr = (await s.request("perf")).realtime;
      ok("dom:click with mouseover / pointerenter draw handlers: the handlers ran, nothing counted as real time", a.hovers >= 2 && a.clicks === 1 && rtr && rtr.calls === 0, { a, rtr });
      ok("an inline window.WITNESS_CONFIG script is not counted as an early classic script (no inject tip)", rtr && rtr.early_scripts.inline === 0, rtr);
    } finally { await g.stop(); }
  }

  // 3. the CLI, two separate processes: the same shot mid-transition, byte for byte
  const files = [1, 2].map((i) => path.join(os.tmpdir(), `witness-dom-${process.pid}-${i}.png`));
  const runs = files.map((out) => spawnSync(process.execPath, [cli, "shot", "--at", "0.8", "--input", "space@0.3", "--out", out], { cwd: P("dom"), encoding: "utf8", timeout: 180000, env: process.env }));
  const pics = files.map((f2) => (fs.existsSync(f2) ? decodePNG(fs.readFileSync(f2)) : null));
  ok("witness shot twice (two browsers, one after the other): identical pictures mid-transition", runs.every((r) => r.status === 0) && same(pics[0], pics[1]) && px(pics[0], 125, 80)[0] < 230, runs.map((r) => r.stdout + r.stderr).join("\n"));
  for (const f2 of files) fs.rmSync(f2, { force: true });
  const doc = spawnSync(process.execPath, [cli, "doctor", "--time", "1", "--json"], { cwd: P("dom"), encoding: "utf8", timeout: 240000, env: process.env });
  let j = null;
  try { j = JSON.parse(doc.stdout); } catch { /* below */ }
  const lines = j ? j.data.lines.join("\n") : doc.stdout + doc.stderr;
  ok("doctor on the DOM page: deterministic, no 'no visible <canvas>' warning, the DOM capture and the epoch named", j && j.summary.deterministic === true && !/⚠ no visible <canvas>/.test(lines) && /DOM page \(no visible <canvas>\)/.test(lines) && /clock: the game's Date starts at 2026-06-15/.test(lines) && /browser \(DOM\)/.test(lines), lines);
  ok("doctor on the DOM page (launch.inject, transitions, a rAF loop, end events): nothing on real time between frames, no inject tip", j && j.summary.web.realtime && j.summary.web.realtime.calls === 0 && !/real time between frames|inline classic/.test(lines), lines);
  for (const n of ["dom", "dom-plain", "dom-boot", "hover"]) fs.rmSync(path.join(P(n), "witness"), { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
