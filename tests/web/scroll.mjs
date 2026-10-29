// 0.7.11: scrolling a real page (tests/web/pages/scroll.html on an iPhone 15 viewport: a fixed bottom tab bar over
// "Save current look", a panel with its own scroll). 1. the JS adapter: a wheel input scrolls the page (or the panel
// under it) like a browser, at once and in whole pixels; play's page measurement finds the bar and the distance. 2. the
// real CLI: `witness play` refuses the covered pick with the fix, `scroll to` brings it clear, the pick lands, and the
// replay repeats it exactly. Run: node tests/web/scroll.mjs (also run by tests/web/run.mjs). One browser at a time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, typeof extra === "string" ? extra.slice(-2500) : JSON.stringify(extra)); } };

function findPlaywright() {
  for (const dir of [process.env.WITNESS_PLAYWRIGHT, path.join(root, "examples", "js-browser"), root].filter(Boolean)) {
    try { createRequire(path.join(dir, "package.json")).resolve("playwright"); return dir; } catch { /* next */ }
  }
  return null;
}
const pwDir = findPlaywright();
if (!pwDir) console.log("  scroll page: skipped (no Playwright)");
else {
  process.env.WITNESS_PLAYWRIGHT = pwDir;
  const proj = path.join(here, "projects", "scroll");
  const { findConfig, openGame } = await import(pathToFileURL(path.join(root, "src", "core", "launch.js")).href);
  const { begin, stepTo, queueInput } = await import(pathToFileURL(path.join(root, "src", "core", "runner.js")).href);
  const { measureExpr, scrollAdvice, blockedOf } = await import(pathToFileURL(path.join(root, "src", "play", "scroll.js")).href);

  // 1. the adapter's wheel and the page measurement
  {
    const f = findConfig(proj);
    const g = await openGame(f.config, f.root, { quiet: true });
    try {
      const s = g.session, st = await begin(s, { seed: 1 });
      await stepTo(s, st, 5);
      const m0 = (await s.eval(measureExpr({ id: "save", label: "Save current look" }))).value;
      ok("measure: Save found, covered by the fixed bar at the bottom (#tabs), 90 px bar, a distance to scroll down", m0 && m0.found && !m0.inView && m0.coveredBy === "the fixed bar at the bottom (#tabs)" && m0.bars.bottom >= 88 && m0.bars.bottom <= 94 && m0.dy > 0 && m0.room > 0 && m0.canvas === false, m0);
      const byLabel = (await s.eval(measureExpr({ id: null, label: "save current look" }))).value;
      ok("measure: found by its label too (no id)", byLabel && byLabel.found && byLabel.rect.join() === m0.rect.join(), byLabel);
      const tap0 = (await s.call("tap", ["save"])).result;
      ok("dom.tap refuses the covered button (as a finger would be)", /^blocked by #tab-/.test(String(tap0)), tap0);
      // the wheel over the page (at the measured point): the page moves by exactly dy, at once
      await queueInput(s, st, [{ frame: 6, type: "wheel", dy: m0.dy, x: m0.at[0], y: m0.at[1] }]);
      await stepTo(s, st, 9);
      let a = (await s.snapshot()).state;
      const m1 = (await s.eval(measureExpr({ id: "save", label: "Save current look" }))).value;
      ok("wheel input scrolls the page by its dy in whole pixels; Save is in view and clear of the bar", a.y === m0.dy && m1.inView && !m1.coveredBy && Math.abs(m1.dy) <= 1, { y: a.y, dy: m0.dy, m1 });
      ok("then the tap lands", (await s.call("tap", ["save"])).result === "ok" && (await s.snapshot()).state.saved === 1);
      // over the panel (its own scroll): the panel moves, not the page; at its end the page doesn't take over here
      await queueInput(s, st, [{ frame: 10, type: "wheel", dy: -10000, x: 200, y: 400 }]);
      await stepTo(s, st, 12);
      const top = (await s.eval(measureExpr({ page: true }))).value;
      ok("page measurement: y and max", top.page && top.y === 0 && top.max > 0, top);
      await queueInput(s, st, [{ frame: 13, type: "wheel", dy: 150, x: 100, y: 60 }]);
      await stepTo(s, st, 15);
      a = (await s.snapshot()).state;
      ok("a wheel over a scrollable panel scrolls the panel (150 px), not the page", a.panelY === 150 && a.y === 0, a);
      // a locked page (body overflow hidden: a canvas game, or a DOM game scrolling inner panels): a wheel leaves it alone
      await s.eval("(document.body.style.overflow = 'hidden', 1)");
      await queueInput(s, st, [{ frame: 16, type: "wheel", dy: 300, x: 200, y: 400 }]);
      await stepTo(s, st, 18);
      const locked = (await s.eval(measureExpr({ page: true }))).value;
      ok("body overflow hidden: a wheel doesn't scroll the page (as a browser), and the measurement says it can't (max 0)", (await s.snapshot()).state.y === 0 && locked.max === 0, { y: (await s.snapshot()).state.y, locked });
      await s.eval("(document.body.style.overflow = '', 1)");
      // a modal overlay over the whole screen (a dialog's backdrop): not a bar; the fix is to close it, not to scroll
      await s.eval("(document.body.insertAdjacentHTML('beforeend', '<div id=\"ov\" style=\"position:fixed;inset:0;background:#0008;z-index:5\"></div>'), 1)");
      const tapOv = (await s.call("tap", ["save"])).result;
      const mOv = (await s.eval(measureExpr({ id: "save", label: "Save current look" }))).value;
      const advOv = scrollAdvice("Save current look", mOv, blockedOf(tapOv));
      ok("an overlay over the screen: the tap is blocked by it, measured as an overlay (no bars), the fix is to close it", tapOv === "blocked by #ov" && mOv.overlay === true && mOv.coveredBy === "#ov (an overlay over the screen)" && mOv.bars.top === 0 && mOv.bars.bottom === 0 && advOv === "covered by #ov (an overlay over the screen): close it first (scrolling won't clear it)", { tapOv, mOv, advOv });
      await s.eval("(document.getElementById('ov').remove(), 1)");
      // a page that cancels the wheel (its own zoom) isn't scrolled
      await s.eval("(addEventListener('wheel', (e) => e.preventDefault(), { passive: false }), 1)");
      await queueInput(s, st, [{ frame: 19, type: "wheel", dy: 300, x: 200, y: 400 }]);
      await stepTo(s, st, 21);
      ok("a cancelled wheel (preventDefault) scrolls nothing", (await s.snapshot()).state.y === 0);
    } finally { await g.stop(); }
  }

  // 2. the real CLI: play on the page, then the replay
  {
    const { witness } = await import(pathToFileURL(path.join(root, "tests", "play", "agent.mjs")).href);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-scroll-"));
    const env = { WITNESS_PLAY_REGISTRY: path.join(tmp, "registry"), WITNESS_PLAY_MAX: "1" };
    try {
      let r = witness(["play", "start", "--name", "sc1", "--goal", "save your look"], { cwd: proj, env });
      ok("play start on the page: the choices list Save", r.code === 0 && /Save current look/.test(r.out), r.out);
      r = witness(["play", "do", "pick save current look", "-s", "sc1"], { cwd: proj, env });
      ok("play: the covered pick fails with the fix (the bar named, scroll down 1, or scroll to)", /couldn't pick \d+\) "Save current look" \(the tap was refused: called tap\(save\) → "blocked by #tab-\w+"\): covered by the fixed bar at the bottom \(#tabs\): scroll down 1 \(or "scroll to save current look"\), then pick again/.test(r.out), r.out);
      r = witness(["play", "do", "scroll to save current look", "-s", "sc1"], { cwd: proj, env });
      ok("play: scroll to brings it into view, clear of the bar", r.code === 0 && /scrolled \d+ px down: \d+\) "Save current look" is in view now, clear of the fixed bars/.test(r.out), r.out);
      r = witness(["play", "do", "pick save current look", "-s", "sc1", "--json"], { cwd: proj, env });
      let j = null; try { j = JSON.parse(r.out); } catch { /* below */ }
      ok("play: now the pick lands (saved 1)", j && /picked \d+\) "Save current look"/.test(j.result.line) && !/✖/.test(j.result.line), r.out);
      r = witness(["play", "do", "scroll top; scroll down 2", "-s", "sc1"], { cwd: proj, env });
      ok("play: scroll top, then scroll down 2 (400 px), with where the page is", r.code === 0 && /scrolled to the top: page \d+ → 0 of \d+ px \(the top\)/.test(r.out) && /scrolled down 2 \(400 px\): page 0 → \d+ of \d+ px/.test(r.out), r.out);
      r = witness(["play", "end", "-s", "sc1", "--fun", "3", "--difficulty", "2", "--feedback", "fine"], { cwd: proj, env });
      ok("play end", r.code === 0 && /report:/.test(r.out), r.out);
      const dir = path.join(proj, "witness", "playtests", "sc1");
      r = witness(["replay", path.join(dir, "replay.jsonl")], { cwd: proj, env });
      ok("the replay (wheel input and calls recorded; measurements not) ends in exactly the recorded state", r.code === 0 && /ended in exactly the recorded end state/.test(r.out), r.out);
    } finally {
      witness(["play", "stop", "--all"], { cwd: proj, env });
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(path.join(proj, "witness"), { recursive: true, force: true });
    }
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
