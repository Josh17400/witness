// Witness play 0.7.11: the scroll order (scroll down|up [n], scroll top|bottom, scroll to <choice>) and the fix a
// pick gets when its target is covered (a fixed tab bar) or off screen. Unit tests without processes: a list game
// that scrolls on wheel input and lists choices with rects; a page "measured" by a fake eval (the real page and the
// real CLI run in tests/web/scroll.mjs). Run: node tests/play/scroll.mjs
import { parseOrders, ORDER_CARD_TURN } from "../../src/play/orders.js";
import { NavGrid } from "../../src/play/grid.js";
import { resolvePlayConfig } from "../../src/play/config.js";
import { Perceiver } from "../../src/play/perceive.js";
import { Autopilot } from "../../src/play/autopilot.js";
import { blockedOf, scrollAdvice, parseScroll, measureExpr, shortWords, stepsFor } from "../../src/play/scroll.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, String(extra).slice(0, 3000)); } };

/** A 400×300 menu of 12 rows 40 px tall, scrolled by wheel input (dy px); the game can also scroll on a call. */
class ListGame {
  constructor({ wheel = true, rects = true } = {}) { this.frame = 0; this.y = 0; this.max = 12 * 40 - 300; this.picked = []; this.wheel = wheel; this.rects = rects; this.calls = []; }
  step() { this.frame++; }
  input(evs) { for (const e of evs) if (e.type === "wheel" && this.wheel) this.y = Math.max(0, Math.min(this.max, this.y + e.dy)); }
  choices() { return Array.from({ length: 12 }, (_, i) => ({ label: i === 9 ? "Save current look" : `Row ${i + 1}`, id: `r${i + 1}`, ...(this.rects ? { rect: [20, i * 40 - this.y, 200, 36] } : {}) })); }
  call(name, args) {
    this.calls.push([name, ...args]);
    if (name === "pick") { const c = this.choices().find((x) => x.id === args[0]); if (c.rect && (c.rect[1] + 18 < 0 || c.rect[1] + 18 >= 300)) return "blocked by nothing (off screen)"; this.picked.push(args[0]); return true; }
    if (name === "reveal") { const i = +String(args[0]).slice(1) - 1; this.y = Math.max(0, Math.min(this.max, i * 40 - 130)); return true; }
    throw new Error(`no call ${name}`);
  }
  snapshot() { return { frame: this.frame, time: this.frame / 60, state: { scene: "menu", choices: this.choices(), scrollY: this.y } }; }
}

/** The daemon's loop without processes (as tests/play/turn.mjs), plus inputs to the game and an eval answer. */
function driver(g, play, evalFn = null, size = [400, 300]) {
  const cfg = resolvePlayConfig({ profile: "turn", ...play }, { keys: [] });
  const per = new Perceiver(cfg, { fps: 60 });
  let w = per.perceive(g.snapshot(), g.frame);
  const ap = new Autopilot(cfg, { fps: 60, grid: new NavGrid({ cell: w.cell, origin: [0, 0] }), perceiver: per, ...(size ? { size } : {}) });
  ap.observe(w);
  const inputs = [], evals = [];
  const step = (k) => { for (let i = 0; i < k; i++) g.step(); w = per.perceive(g.snapshot(), g.frame); ap.observe(w); };
  return {
    cfg, ap, inputs, evals,
    do(text, maxFrames = 1200) {
      ap.setOrders(parseOrders(text, { named: cfg.named }));
      const f0 = g.frame;
      for (let guard = 0; guard < 5000 && g.frame - f0 < maxFrames; guard++) {
        const d = ap.decide(w);
        const ev = ap.ctrl.emit(d.want, g.frame);
        if (ev.length) { inputs.push(...ev); g.input(ev); }
        if (d.status === "call") {
          let v, failed = false;
          try { v = g.call(d.name, d.args); } catch (e) { failed = true; v = e.message; }
          if (ap.cur) { ap.cur.result = `called ${d.name}(${d.args.join(", ")}) → ${JSON.stringify(v)}`; ap.cur.callValue = v; ap.cur.callFailed = failed; }
          step(1); continue;
        }
        if (d.status === "eval") {
          evals.push(d.expr);
          let v, failed = !evalFn;
          if (evalFn) { try { v = evalFn(d.expr); } catch { failed = true; } }
          if (ap.cur) { ap.cur.evalValue = failed ? undefined : v; ap.cur.evalFailed = failed; }
          continue;
        }
        if (d.status !== "run") return { status: d.status, msg: ap.results.length > 1 ? ap.results.map((r) => r.msg).join(" → ") : d.message };
        step(Math.max(1, d.k));
      }
      return { status: "time", msg: "" };
    },
  };
}

// ---- parsing
{
  const p = (t) => parseOrders(t)[0];
  ok("parse: scroll down / up [n], bare scroll, a number", p("scroll down").dir === "down" && p("scroll down").n === 1 && p("scroll down 3").n === 3 && p("scroll up 2").dir === "up" && p("scroll").dir === "down" && p("scroll 2").n === 2);
  ok("parse: scroll top / bottom (also 'to the top', 'to the bottom')", p("scroll top").dir === "top" && p("scroll to the top").dir === "top" && p("scroll to the bottom").dir === "bottom" && p("scroll bottom").dir === "bottom");
  ok("parse: scroll to <words> / <n> / a quoted label / an ordinal", p("scroll to Save current look").optionText === "Save current look" && p("scroll to Save current look").to === true && p("scroll to 4").option === 4 && p("scroll to 'Top hats'").optionText === "Top hats" && p("scroll to the third").option === 3);
  ok("parse: swipe up = scroll down (the finger moves the page up)", p("swipe up").dir === "down" && p("swipe down").dir === "up");
  ok("parse: chains (scroll down, then pick 2)", parseOrders("scroll down then pick 2").map((o) => o.verb).join() === "scroll,choose");
  ok("the turn order card lists scroll", /scroll <down\|up> \[n\] · scroll top\|bottom · scroll to <n\|words>/.test(ORDER_CARD_TURN));
  ok("play.scroll: forms and the step", parseScroll(undefined).step === 200 && parseScroll(undefined).call === null && parseScroll("call:reveal").call === "reveal" && parseScroll({ call: "reveal", args: ["label"], step: 120 }).args[0] === "label" && parseScroll({ step: 120 }).step === 120);
  ok("blockedOf: dom.tap's answers and refusals that say so", blockedOf("blocked by #tabs").what === "#tabs" && blockedOf("blocked by nothing (off screen)").offscreen === true && blockedOf({ ok: false, error: "the button is covered by the toast" }).what === "the toast" && blockedOf("ok") === null && blockedOf(true) === null && blockedOf({ ok: false, error: "not your turn" }) === null);
  ok("stepsFor / shortWords", stepsFor(30, 200) === 1 && stepsFor(450, 200) === 3 && stepsFor(-450, 200) === 3 && shortWords("Save current look (selected) #2") === "save current look");
  ok("measureExpr: a self-contained page expression (no 'state' word: the adapter would snapshot for it)", /^\(function measureInPage\(a\)/.test(measureExpr({ page: true })) && !/\bstate\b/.test(measureExpr({ id: "x", label: "y" })));
}

// ---- scroll to: the choice's rect against the screen (no eval), wheel input until it's on screen
{
  const g = new ListGame(), d = driver(g, { pick: { call: "pick" } });
  let r = d.do("pick save current look");
  ok("pick: a choice off screen (rect below the 300 px view) is refused by the game's tap: the fix names the scroll (its rect: 228 px past the middle, 2 steps)", r.status === "fail" && /couldn't pick 10\) "Save current look" \(the tap was refused/.test(r.msg) && /off screen: scroll down 2 \(or "scroll to save current look"\), then pick again/.test(r.msg) && !g.picked.length, r.msg);
  r = d.do("scroll to save current look");
  const wh = d.inputs.filter((e) => e.type === "wheel");
  ok("scroll to (rect only, no eval): wheel input by the distance to the middle (the list stops at its end), then on screen", r.status === "done" && /scrolled 228 px down: 10\) "Save current look" is on screen now \(its centre at y 198 of 300\)/.test(r.msg) && wh.length === 1 && wh[0].dy === 228 && g.y === 180, `${r.msg} ${JSON.stringify(wh)} y=${g.y}`);
  r = d.do("pick save");
  ok("then the pick lands", r.status === "done" && g.picked.join() === "r10", r.msg);
  r = d.do("scroll to row 1");
  ok("scroll to a choice above: wheel up", r.status === "done" && g.y === 0 && /px up/.test(r.msg), `${r.msg} y=${g.y}`);
  r = d.do("scroll to 2");
  ok("scroll to a choice already on screen: nothing sent", r.status === "done" && /on screen already/.test(r.msg) && d.inputs.filter((e) => e.type === "wheel").length === 2, r.msg);
  r = d.do("scroll to nothing like it");
  ok("scroll to words that match no choice, no eval to look on the page: a clear failure", r.status === "fail" && /can't say where things are|nothing on the page/.test(r.msg), r.msg);
}

// ---- scroll down / up / top / bottom without eval: blind wheels, said so
{
  const g = new ListGame(), d = driver(g, {});
  let r = d.do("scroll down 1");
  ok("scroll down 1 (no eval): one wheel of play.scroll.step (200 px), said plainly", r.status === "done" && /scrolled down 1 \(200 px\): wheel sent/.test(r.msg) && g.y === 180, `${r.msg} y=${g.y}`);
  r = d.do("scroll top");
  ok("scroll top (no eval): a big wheel up", r.status === "done" && g.y === 0, `${r.msg} y=${g.y}`);
  const g2 = new ListGame({ wheel: false }), d2 = driver(g2, {});
  r = d2.do("scroll to save current look");
  ok("scroll to in a game that ignores the wheel: says the wheel didn't move it", r.status === "fail" && /didn't move it/.test(r.msg) && /play\.scroll call/.test(r.msg), r.msg);
}

// ---- play.scroll: the game's own call
{
  const g = new ListGame(), d = driver(g, { pick: { call: "pick" }, scroll: { call: "reveal" } });
  const r = d.do("scroll to save current look");
  ok("scroll to with play.scroll.call: the game's call with the choice's id, no wheel", r.status === "done" && /scrolled to 10\) "Save current look" \(called reveal\(r10\)/.test(r.msg) && g.calls.some((c) => c[0] === "reveal" && c[1] === "r10") && !d.inputs.some((e) => e.type === "wheel"), r.msg);
}

// ---- a page measured by eval (a fake page: a 300 px view, a 60 px fixed tab bar at the bottom)
{
  // the page: scroll position y of max 900; "Save current look" at page y 270..310 (centre 290): under the bar at y 0
  const page = { y: 0, max: 900 };
  const g = new ListGame({ rects: false });
  g.input = (evs) => { for (const e of evs) if (e.type === "wheel") page.y = Math.max(0, Math.min(page.max, page.y + e.dy)); };
  g.call = (name, args) => { g.calls.push([name, ...args]); const cy = 290 - page.y; if (args[0] === "r10" && cy >= 240) return "blocked by #tabs"; g.picked.push(args[0]); return "ok"; };
  const measure = (expr) => {
    const a = JSON.parse(/\)\((.*)\)$/.exec(expr)[1]);
    if (a.page) return { page: true, y: page.y, max: page.max, h: 300, vw: 400, vh: 300, canvas: false };
    if (!/save/i.test(a.label)) return { found: false };
    const top = 270 - page.y, cy = top + 20, covered = cy >= 240 && cy < 300;
    return { found: true, rect: [20, top, 200, 40], vw: 400, vh: 300, canvas: false, inView: !covered && top >= 0 && top + 40 <= 240, clear: !covered && cy >= 0 && cy < 300, offscreen: cy < 0 ? "above" : cy >= 300 ? "below" : null, where: cy >= 240 ? "below" : null,
      coveredBy: covered ? "the fixed bar at the bottom (#tabs)" : null, bars: { top: 0, bottom: 60 }, dy: Math.round(cy - 120), need: top + 40 > 240 ? top + 40 - 240 + 8 : 0, room: cy - 120 > 0 ? page.max - page.y : page.y, scroll: { y: page.y, max: page.max, h: 300 }, at: [200, 120] };
  };
  const d = driver(g, { pick: { call: "tap" } }, measure);
  let r = d.do("pick save current look");
  ok("pick refused as covered by the tab bar: measured on the page, the fix is exact (scroll down 1)", r.status === "fail" && /couldn't pick 10\) "Save current look" \(the tap was refused: called tap\(r10\) → "blocked by #tabs"\): covered by the fixed bar at the bottom \(#tabs\): scroll down 1 \(or "scroll to save current look"\), then pick again/.test(r.msg) && d.evals.length === 1, r.msg);
  r = d.do("scroll to save current look");
  const wh = d.inputs.filter((e) => e.type === "wheel");
  ok("scroll to (measured): one wheel at the scroller's point by the exact distance; in view, clear of the bar", r.status === "done" && /scrolled 170 px down: 10\) "Save current look" is in view now, clear of the fixed bars/.test(r.msg) && wh.length === 1 && wh[0].dy === 170 && wh[0].x === 200 && wh[0].y === 120 && page.y === 170, `${r.msg} ${JSON.stringify(wh)}`);
  r = d.do("pick save current look");
  ok("then the pick lands", r.status === "done" && g.picked.join() === "r10", r.msg);
  r = d.do("scroll down 2");
  ok("scroll down 2 (measured): 400 px, where the page is before and after", r.status === "done" && /scrolled down 2 \(400 px\): page 170 → 570 of 900 px/.test(r.msg) && d.inputs.filter((e) => e.type === "wheel").at(-1).x === 200 && d.inputs.filter((e) => e.type === "wheel").at(-1).y === 150, r.msg);
  r = d.do("scroll bottom");
  ok("scroll bottom: exactly the rest of the page", r.status === "done" && /scrolled to the bottom: page 570 → 900 of 900 px \(the bottom\)/.test(r.msg) && d.inputs.filter((e) => e.type === "wheel").at(-1).dy === 330, r.msg);
  r = d.do("scroll down");
  ok("scroll down at the bottom: nothing moved, said so", r.status === "done" && /nothing moved \(already at the bottom, page 900 of 900 px\)/.test(r.msg), r.msg);
  r = d.do("scroll bottom");
  ok("scroll bottom at the bottom: no wheel", r.status === "done" && /already at the bottom/.test(r.msg), r.msg);
  r = d.do("scroll to the top");
  ok("scroll to the top: back to 0", r.status === "done" && page.y === 0 && /page 900 → 0 of 900 px \(the top\)/.test(r.msg), r.msg);
  r = d.do("scroll to Nowhere Land");
  ok("scroll to words not on the page: the choices listed", r.status === "fail" && /nothing on the page reads like that \(choices: 1\) Row 1/.test(r.msg), r.msg);
  // a page that can't scroll it clear (the bar covers the end of a page with no room)
  page.max = 0;
  r = d.do("scroll to save current look");
  ok("scroll to a choice the page can't bring clear of the bar: a failure naming the bar", r.status === "fail" && /the page can't scroll further \(covered by the fixed bar at the bottom \(#tabs\)\)/.test(r.msg), r.msg);
  r = d.do("pick save current look");
  ok("pick: covered and no room: says a player would hit it too", r.status === "fail" && /can't scroll further down to clear it \(a layout bug a player would hit too\)/.test(r.msg), r.msg);
}

// ---- other profiles still parse and run scroll; a topdown order set is unchanged
{
  const cfg = resolvePlayConfig({ profile: "topdown" }, { keys: [] });
  ok("topdown config has the scroll defaults (scroll is open to every profile)", cfg.scroll.step === 200 && cfg.scroll.call === null);
  ok("scrollAdvice: no measurement, a blocked tap: the generic fix", /^covered by #bar: scroll down 1 \(or "scroll to save"\), then pick again$/.test(scrollAdvice("Save", null, { what: "#bar", offscreen: false })));
  const off = { what: "nothing (off screen)", offscreen: true };
  ok("scrollAdvice: no measurement, the choice's rect above the view: up, by the distance to the middle (282 + 150 px: 3)", /^off screen: scroll up 3 \(or "scroll to save"\), then pick again$/.test(scrollAdvice("Save", null, off, 200, [20, -300, 200, 36], [400, 300])), scrollAdvice("Save", null, off, 200, [20, -300, 200, 36], [400, 300]));
  ok("scrollAdvice: no measurement, far below: down by the distance (1000 px rect y, 3 steps of 300)", /^off screen: scroll down 3 /.test(scrollAdvice("Save", null, off, 300, [20, 1000, 200, 36], [400, 300])) && /^off screen: scroll up 2 /.test(scrollAdvice("Save", null, off, 200, [20, -300, 200, 36], null)) && /^off screen: scroll down 1 /.test(scrollAdvice("Save", null, off, 200, [20, 900, 200, 36], null)));
  const ov = { found: true, rect: [20, 100, 200, 40], vw: 400, vh: 300, inView: false, clear: false, offscreen: null, where: null, coveredBy: "#ov (an overlay over the screen)", overlay: true, bars: { top: 0, bottom: 0 }, dy: -20, need: 0, room: 500, scroll: { y: 0, max: 500, h: 300 }, at: [200, 150] };
  ok("scrollAdvice: covered by an overlay: close it first, no scroll steps", scrollAdvice("Save", ov, { what: "#ov", offscreen: false }) === "covered by #ov (an overlay over the screen): close it first (scrolling won't clear it)", scrollAdvice("Save", ov, { what: "#ov" }));
  const g = new ListGame({ rects: false }), d = driver(g, {}, () => ov);
  const r = d.do("scroll to save current look");
  ok("scroll to a choice under an overlay: fails at once, close it first, no wheel", r.status === "fail" && /scroll to 10\) "Save current look": covered by #ov \(an overlay over the screen\): close it first \(scrolling won't clear it\), nothing sent/.test(r.msg) && !d.inputs.some((e) => e.type === "wheel"), r.msg);
}

// ---- a click pick without a declared size (no hello.size: the daemon's 640×360 is a guess): sent, as in 0.7.10
{
  const g = new ListGame();
  g.choices = () => [{ label: "Deal", id: "deal", rect: [700, 500, 100, 40] }];
  const clicks = [];
  g.input = (evs) => { for (const e of evs) if (e.type === "mouse" && e.down) { clicks.push([e.x, e.y]); g.picked.push("deal"); } };
  let r = driver(g, { pick: "click" }, null, null).do("pick deal", 120);
  ok("click pick at y 520 with no declared size: the click is sent (not refused as off screen)", clicks.length === 1 && clicks[0].join() === "750,520" && !/off screen/.test(r.msg), `${r.status} ${r.msg} ${JSON.stringify(clicks)}`);
  const g2 = new ListGame(); g2.choices = g.choices; const c2 = [];
  g2.input = (evs) => { for (const e of evs) if (e.type === "mouse" && e.down) c2.push(1); };
  r = driver(g2, { pick: "click" }).do("pick deal", 120);
  ok("with a declared 400×300 size the same click is refused as off screen, nothing sent", r.status === "fail" && /off screen \(below the 400×300 view, nothing sent\)/.test(r.msg) && !c2.length, r.msg);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
