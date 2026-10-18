// Witness core: find witness.json, start the game in witness mode, return a connected Session.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { listen, WitnessError } from "./session.js";

export const CONFIG_NAME = "witness.json";
export const DEFAULT_ATTACH_PORT = 7357;

/** Walk up from `start` to find witness.json. Returns {config, root, file} or null. */
export function findConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  for (;;) {
    const f = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(f)) {
      let config;
      try { config = JSON.parse(fs.readFileSync(f, "utf8")); }
      catch (e) { throw new WitnessError(`${f} isn't valid JSON: ${e.message}`); }
      return { config: normalize(config), root: dir, file: f };
    }
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
 * Start (or attach to) the game and return {session, stop(), proc, output()}.
 * opts: {attach, port, timeout, env, quiet}
 */
export async function openGame(cfg, root, opts = {}) {
  const launch = cfg.launch || {};
  const attach = opts.attach || launch.attach;
  const srv = await listen({ port: attach ? (opts.port || launch.port || DEFAULT_ATTACH_PORT) : 0 });
  const addr = `127.0.0.1:${srv.port}`;
  let proc = null, browser = null, server = null;
  const out = [];
  const keep = (d) => { out.push(d.toString()); if (out.length > 400) out.splice(0, out.length - 400); };

  try {
    if (attach) {
      if (!opts.quiet) console.error(`▸ waiting for a game to connect on ${addr} (start it with WITNESS_ADDR=${addr}, or the adapter's default)…`);
    } else if (launch.url) {
      // Browser games: optional dev server + headless browser (see src/core/browser.js).
      const { openBrowserGame } = await import("./browser.js");
      ({ browser, server } = await openBrowserGame(launch, root, addr, keep));
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
