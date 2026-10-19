// Witness core: find witness.json, start the game in witness mode, return a connected Session.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { listen, WitnessError } from "./session.js";

export const CONFIG_NAME = "witness.json";
export const DEFAULT_ATTACH_PORT = 7357;

// A Windows path written with single backslashes is still valid JSON but silently wrong: "tools\build.bat" holds a
// backspace (\b), "src\new" a newline. No real command or path contains control characters, so refuse them.
function checkControlChars(v, file, at = "") {
  if (typeof v === "string") {
    const m = /[\u0000-\u001f]/.exec(v);
    if (m) {
      const shown = JSON.stringify(v), esc = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" }[m[0]] || `\\u${m[0].charCodeAt(0).toString(16).padStart(4, "0")}`;
      throw new WitnessError(`${file}: ${at || "a value"} is ${shown}: it contains ${esc}, which JSON reads as a control character — ` +
        "a Windows path needs doubled backslashes (\"tools\\\\build.bat\") or forward slashes (\"tools/build.bat\")");
    }
  } else if (Array.isArray(v)) v.forEach((x, i) => checkControlChars(x, file, `${at}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) checkControlChars(x, file, at ? `${at}.${k}` : k);
}

function readConfig(f) {
  let config;
  try { config = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { throw new WitnessError(`${f} isn't valid JSON: ${e.message}`); }
  checkControlChars(config, f);
  return { config: normalize(config), root: path.dirname(f), file: f };
}

/** `start` is a folder (walk up from it to a witness.json) or a config file of any name (witness.web.json beside
 *  witness.json): that file is loaded, and its folder is the project root. */
export function findConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
    if (/\.json$/i.test(dir)) return readConfig(dir);
    dir = path.dirname(dir);
  }
  for (;;) {
    const f = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(f)) return readConfig(f);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function normalize(c) {
  return {
    name: c.name || "game",
    launch: c.launch || null,       // {command, args, cwd, env} | {attach: true, port} | {url, server?}
    build: c.build || null,         // shell command run by --build
    tests: c.tests || "witness",    // folder (or file) with *.witness.json / *.witness.mjs
    fps: c.fps || null,             // overrides the adapter's hello.fps
    seed: c.seed ?? 1,
    timeout: c.timeout || 60,       // seconds to wait for the game to connect
    shots: c.shots || "witness/shots",
    replays: c.replays || "witness/replays",
    ...c,
  };
}

export function runBuild(cfg, root, { quiet = false } = {}) {
  if (!cfg.build) return true;
  if (!quiet) console.error(`▸ build: ${cfg.build}`);
  const r = spawnSync(cfg.build, { cwd: root, shell: true, stdio: quiet ? "pipe" : "inherit" });
  if (r.status !== 0) throw new WitnessError(`build failed (exit ${r.status}): ${cfg.build}${quiet && r.stderr ? "\n" + r.stderr.toString().slice(-2000) : ""}`);
  return true;
}

/**
 * Browser launches: session.web (device, engine, audio policy, page facts), the auto-unlock gesture at connect, and
 * screenshots from the screen (capture "element" / "screen") instead of the adapter's canvas readback.
 */
async function attachWeb(session, web) {
  session.web = web;
  if (web.policy === "auto") { try { web.autoUnlocked = await web.unlock(); } catch { web.autoUnlocked = 0; } }
  if (web.captureMode !== "canvas") {
    const caps = session.hello.capabilities || (session.hello.capabilities = []);
    if (!caps.includes("screenshot")) caps.push("screenshot");
    session.screenshot = async () => {
      const c = await web.capture(web.captureMode);
      return { width: c.width, height: c.height, format: "png", data: c.png.toString("base64") };
    };
  }
}

/**
 * Start (or attach to) the game and return {session, stop(), proc, output()}.
 * opts: {attach, port, timeout, env, quiet}
 */
export async function openGame(cfg, root, opts = {}) {
  const launch = cfg.launch || {};
  const attach = opts.attach || launch.attach;
  const srv = await listen({ port: attach ? (opts.port || launch.port || DEFAULT_ATTACH_PORT) : 0 });
  const addr = `127.0.0.1:${srv.port}`;
  let proc = null, browser = null, server = null, web = null;
  const out = [];
  const keep = (d) => { out.push(d.toString()); if (out.length > 400) out.splice(0, out.length - 400); };

  try {
    if (attach) {
      if (!opts.quiet) console.error(`▸ waiting for a game to connect on ${addr} (start it with WITNESS_ADDR=${addr}, or the adapter's default)…`);
    } else if (launch.url) {
      // Browser games: optional dev server + headless browser (see src/core/browser.js).
      const { openBrowserGame } = await import("./browser.js");
      ({ browser, server, web } = await openBrowserGame(launch, root, addr, keep));
    } else if (launch.command) {
      const env = { ...process.env, ...(launch.env || {}), ...(opts.env || {}), WITNESS_ADDR: addr, WITNESS: "1" };
      proc = spawn(launch.command, launch.args || [], {
        cwd: path.resolve(root, launch.cwd || "."), env, shell: !!launch.shell, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", keep);
      proc.stderr.on("data", keep);
      proc.on("error", (e) => keep(`[witness] failed to start: ${e.message}\n`));
    } else {
      throw new WitnessError(`${CONFIG_NAME} has no "launch" — add {"launch": {"command": "path/to/game", "args": []}} (or "attach": true, or "url": "..."). Run 'witness init' for a template.`);
    }

    const exited = proc ? new Promise((res) => proc.on("exit", (code) => res(code))) : new Promise(() => {});
    const session = await Promise.race([
      srv.nextSession((opts.timeout || cfg.timeout || 60) * 1000),
      exited.then((code) => { throw new WitnessError(`the game exited (code ${code}) before connecting to Witness.\n--- game output ---\n${out.join("").slice(-3000)}`); }),
    ]);
    if (cfg.fps) session.hello.fps = cfg.fps;
    if (web) await attachWeb(session, web);
    const stop = async () => {
      await session.quit();
      session.close();
      if (proc && proc.exitCode === null) {
        await new Promise((r) => { const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } r(); }, 2000); proc.once("exit", () => { clearTimeout(t); r(); }); });
      }
      if (browser) await browser.close().catch(() => {});
      if (server) { try { server.kill(); } catch { /* gone */ } }
      srv.close();
    };
    return { session, stop, proc, output: () => out.join("") };
  } catch (e) {
    if (proc && proc.exitCode === null) { try { proc.kill(); } catch { /* gone */ } }
    if (browser) await browser.close().catch(() => {});
    if (server) { try { server.kill(); } catch { /* gone */ } }
    srv.close();
    throw e;
  }
}
