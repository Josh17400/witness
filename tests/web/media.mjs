// 0.7.8 browser launching: launch.media (prefers-reduced-motion / prefers-color-scheme seen by matchMedia and @media),
// dom:tap on a desktop viewport (a click, warned once), a call that never answers (configurable timeout naming the call
// and the unresolved game promise), start()'s ready wait with a decode() that never settles (capped per picture), a
// config in the OS temp folder (Playwright found from the current folder), and play sessions' audio: no capture, the
// same AudioContext clock and ended events as with capture. Run: node tests/web/media.mjs (also run by tests/web/run.mjs).
// Needs Playwright (WITNESS_PLAYWRIGHT, or npm install in examples/js-browser); two browsers, one after the other.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, typeof extra === "string" ? extra.slice(-2500) : JSON.stringify(extra)); } };
const imp = (p) => import(pathToFileURL(path.join(root, ...p.split("/"))).href);

function findPlaywright() {
  for (const dir of [process.env.WITNESS_PLAYWRIGHT, path.join(root, "examples", "js-browser"), root].filter(Boolean)) {
    try { createRequire(path.join(dir, "package.json")).resolve("playwright"); return dir; } catch { /* next */ }
  }
  return null;
}
const pwDir = findPlaywright();
if (!pwDir) console.log("  media page: skipped (no Playwright)");
else {
  const { findConfig, openGame } = await imp("src/core/launch.js");
  const { loadPlaywright } = await imp("src/core/browser.js");
  const { begin, stepTo } = await imp("src/core/runner.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "witness-media-"));
  const cwd = process.cwd(), envPw = process.env.WITNESS_PLAYWRIGHT;

  // Playwright for a config in the temp folder: not there, nor WITNESS_PLAYWRIGHT: found from the current folder
  delete process.env.WITNESS_PLAYWRIGHT;
  process.chdir(pwDir);
  let pw = null, err = "";
  try { pw = await loadPlaywright(tmp); } catch (e) { err = e.message; }
  ok("Playwright for a config in the temp folder: found from the current folder (config folder → cwd → Witness → global)", pw && pw.pw && pw.pw.chromium && pw.version, err);

  // 1. the media project (launch.media reduce + dark), Playwright from the current folder only
  const f = findConfig(path.join(here, "projects", "media"));
  let g = await openGame(f.config, f.root, { quiet: true });
  let A = null;
  try {
    const s = g.session;
    const snap = (await s.snapshot()).state;
    ok("launch.media: matchMedia sees reduce + dark, and the @media rules apply (dark background, no transition)", snap.reduced === true && snap.dark === true && snap.bg === "rgb(10, 20, 30)" && snap.transition === "none", snap);
    ok("launch.media: web.media / web.mediaInfo() / web.state().media", JSON.stringify(s.web.media) === '{"reducedMotion":"reduce","colorScheme":"dark"}' && Object.values(await s.web.mediaInfo()).every(Boolean) && (await s.web.state()).media.colorScheme === "dark");
    ok("audio capture on by default: hello has 'audio'", s.has("audio"), s.hello.capabilities);
    let st = await begin(s, { seed: 1 });
    await stepTo(s, st, 120);
    A = (await s.snapshot()).state;
    // dom:tap on the desktop viewport: a click at the same point, one warning
    const errs = [], w = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c, ...a) => { errs.push(String(c)); return true; };
    try {
      st = await begin(s, { seed: 1, input: "dom:tap:100,50@0.1, dom:tap:100,50@0.2" });
      await stepTo(s, st, 30);
    } finally { process.stderr.write = w; }
    const c = (await s.snapshot()).state.clicks;
    ok("dom:tap on a desktop viewport: sent as clicks (2), warned once", c === 2 && errs.filter((x) => /dom:tap on a desktop viewport/.test(x)).length === 1, [c, errs.join("")]);
    // a call whose promise never resolves: the configurable timeout names it and the unresolved promise
    s.requestTimeoutMs = 1500;
    const msg = await s.call("forever", [7]).then(() => "answered", (e) => e.message);
    ok("call timeout (1.5 s here): names 'call' forever(7) and the game promise still unresolved", /didn't answer 'call' forever\(7\) within 1\.5s/.test(msg) && /waiting on a promise the game returned that never resolved/.test(msg) && /unresolved async calls: forever/.test(msg), msg);
  } finally { await g.stop().catch(() => {}); }

  // 2. a config in the OS temp folder (?hangdecode=1: every decode() pending forever), launched as a play session
  // (audio: false): Playwright from the current folder, start() goes on after ~2.5 s, no capture, the same clock
  const cfgFile = path.join(tmp, "media.witness.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ name: "media-tmp", launch: { url: "http://127.0.0.1:5318/media.html?hangdecode=1", server: { command: `node "${path.join(here, "serve.mjs")}" 5318` } }, seed: 1, timeout: 40 }));
  const t = findConfig(cfgFile);
  const t0 = Date.now();
  g = await openGame(t.config, t.root, { quiet: true, audio: false });
  try {
    const s = g.session, took = Date.now() - t0;
    const logs = await s.drainLogs();
    ok("decode() that never settles: start() went on (capped at 2.5 s per picture) and said so", took < 20000 && logs.some((l) => /never finished decoding within 2500 ms/.test(l.message)), [took, logs.map((l) => l.message)]);
    ok("play session (audio: false): no 'audio' capability, no media emulated", !s.has("audio") && !s.web.media && /witness_audio=0/.test(s.web.url), [s.hello.capabilities, s.web.url]);
    const st = await begin(s, { seed: 1 });
    await stepTo(s, st, 120);
    const B = (await s.snapshot()).state;
    ok("no audio capture: the AudioContext clock, beeps and ended events are exactly the captured run's", A && B.ct === A.ct && B.beeps === A.beeps && B.ended === A.ended && B.ct > 1.9 && B.ended > 5, [A, B]);
  } finally { await g.stop().catch(() => {}); }
  process.chdir(cwd);
  if (envPw != null) process.env.WITNESS_PLAYWRIGHT = envPw;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(here, "projects", "media", "witness"), { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
