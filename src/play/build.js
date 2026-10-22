// Witness play: a playtest that can be replayed later on its own. The session's effective config goes into the playtest
// folder (witness.run.json: paths made absolute or playtest-relative, launch.server kept, so `witness replay` restarts the server a batch
// had running), and a fingerprint of the build it played (the page's HTML and the scripts / styles it loads, or the
// files a command launch runs) goes into the replay header and the report, so a replay against a changed build says so.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const RUN_CONFIG = "witness.run.json";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * The config with every root-relative path made absolute (it no longer lives next to the game); no build step. Given the
 * playtest folder `dir`, tests / shots / replays are written relative to it instead: loaded with --config the root is
 * that folder, and commands that path.join(root, cfg.shots) as well as those that path.resolve it reach the project's.
 */
export function runConfig(cfg, root, dir) {
  const c = JSON.parse(JSON.stringify(cfg || {})), abs = (p) => (p == null || p === "" ? p : path.resolve(root, String(p)));
  delete c.build;   // a replay plays the build that's there; it doesn't rebuild
  for (const k of ["tests", "shots", "replays"]) if (typeof c[k] === "string") { c[k] = abs(c[k]); if (dir) { const r = path.relative(path.resolve(dir), c[k]); if (!path.isAbsolute(r)) c[k] = r.split(path.sep).join("/") || "."; } }
  if (c.launch && !c.launch.attach) {
    if (c.launch.command) c.launch.cwd = abs(c.launch.cwd || ".");
    if (c.launch.server) {
      const s = typeof c.launch.server === "string" ? { command: c.launch.server } : { ...c.launch.server };
      s.cwd = abs(s.cwd || "."); c.launch.server = s;
    }
  }
  if (c.play && c.play.module) c.play = { ...c.play, module: abs(c.play.module) };
  return c;
}

/** Write witness.run.json into the playtest folder → its path (null when it can't be written). */
export function writeRunConfig(dir, cfg, root) {
  const f = path.join(dir, RUN_CONFIG);
  try { fs.writeFileSync(f, JSON.stringify(runConfig(cfg, root, dir), null, 1)); return f; } catch { return null; }
}

/** The page URL without Witness's own query (witness=, witness_seed …). */
const pageUrl = (u) => { const x = new URL(u); for (const k of [...x.searchParams.keys()]) if (/^witness/.test(k)) x.searchParams.delete(k); x.hash = ""; return x.toString(); };
// the resources a page names: script src, stylesheet / modulepreload href, inline module scripts' imports; a script's static
// and dynamic relative imports. Dev-server runtime (Vite's client carries a per-start token, webpack's HMR client) is skipped.
const HTML_REFS = [/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, /<link\b[^>]*\brel\s*=\s*["']?(?:stylesheet|modulepreload|preload)["']?[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']?(?:stylesheet|modulepreload|preload)\b/gi];
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, DEV_RUNTIME = /^\/(@vite\/|@id\/__x00__|@react-refresh|__vite|sockjs-node|webpack-dev-server|__webpack_hmr)/;
const JS_REFS = [/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];

/**
 * A fingerprint of what the game is built from → {kind, url?, hash, files: {name: sha8}, count} or null.
 * Web: the page at launch.url and the same-origin scripts / styles it names (following JS imports), at most 80 files,
 * 3 s each. Command: the files among launch.command / launch.args (relative to launch.cwd) that exist.
 */
export async function fingerprint(cfg, root, { timeoutMs = 3000, max = 80 } = {}) {
  const launch = (cfg && cfg.launch) || {};
  if (launch.attach) return null;
  const files = {};
  if (launch.url) {
    let base; try { base = new URL(pageUrl(launch.url)); } catch { return null; }
    const seen = new Set(), queue = [[base.toString(), "html"]];
    while (queue.length && seen.size < max) {
      const [u, kind] = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      let body;
      try { const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) }); if (!r.ok) { files[nameOf(u, base)] = `http ${r.status}`; continue; } body = Buffer.from(await r.arrayBuffer()); }
      catch { if (u === base.toString()) return null; files[nameOf(u, base)] = "unreachable"; continue; }
      files[nameOf(u, base)] = sha(body).slice(0, 12);
      const txt = kind === "css" ? "" : body.toString("utf8");
      const scans = kind === "html" ? HTML_REFS.map((re) => [re, txt]) : kind === "js" ? JS_REFS.map((re) => [re, txt]) : [];
      if (kind === "html") for (const m of txt.matchAll(INLINE_SCRIPT)) if (!/\bsrc\s*=/i.test(m[1]) && m[2].trim()) for (const re of JS_REFS) scans.push([re, m[2]]);
      for (const [re, src] of scans) {
        for (const m of src.matchAll(re)) {
          let v; try { v = new URL(m[1], u); } catch { continue; }
          if (v.origin !== base.origin || /\/witness\.js$/.test(v.pathname) || DEV_RUNTIME.test(v.pathname)) continue;   // other sites; Witness's own adapter; dev-server runtime
          v.hash = ""; const k = v.toString();
          if (!seen.has(k)) queue.push([k, /\.css(\?|$)/i.test(v.pathname) ? "css" : "js"]);
        }
      }
    }
    return done("web", files, base.toString());
  }
  if (launch.command) {
    const cwd = path.resolve(root, launch.cwd || ".");
    for (const a of [launch.command, ...(launch.args || [])]) {
      if (typeof a !== "string" || a.startsWith("-")) continue;
      const f = path.resolve(cwd, a);
      try { if (fs.statSync(f).isFile() && fs.statSync(f).size < 64e6) files[path.relative(cwd, f).replace(/\\/g, "/") || path.basename(f)] = sha(fs.readFileSync(f)).slice(0, 12); } catch { /* not a file */ }
    }
    return Object.keys(files).length ? done("files", files, null) : null;
  }
  return null;
}
const nameOf = (u, base) => { const x = new URL(u); return x.origin === base.origin ? `${x.pathname}${x.search}` : u; };
function done(kind, files, url) {
  const names = Object.keys(files).sort();
  return { kind, ...(url ? { url } : {}), hash: sha(names.map((n) => `${n} ${files[n]}`).join("\n")).slice(0, 16), count: names.length, files: Object.fromEntries(names.map((n) => [n, files[n]])) };
}

/** What differs between two fingerprints: "index.html, js/game.js changed · js/new.js added" (or null when the same). */
export function buildDiff(a, b) {
  if (!a || !b || a.hash === b.hash) return null;
  const fa = a.files || {}, fb = b.files || {}, list = (xs) => `${xs.slice(0, 4).join(", ")}${xs.length > 4 ? ` +${xs.length - 4}` : ""}`;
  const changed = Object.keys(fa).filter((k) => k in fb && fa[k] !== fb[k]), gone = Object.keys(fa).filter((k) => !(k in fb)), added = Object.keys(fb).filter((k) => !(k in fa));
  const out = [changed.length ? `${list(changed)} changed` : "", gone.length ? `${list(gone)} gone` : "", added.length ? `${list(added)} added` : ""].filter(Boolean);
  return out.join(" · ") || "the files differ";
}

/** The fingerprint a replay file's header recorded (head.build), or null. */
export function recordedBuild(replayFile) {
  try {
    const fd = fs.openSync(replayFile, "r"), buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const head = JSON.parse(buf.toString("utf8", 0, n).split(/\r?\n/)[0]);
    return head && head.replay && head.build ? head.build : null;
  } catch { return null; }
}

/** `witness replay`: "⚠ the build changed since this playtest (…)" when the recorded fingerprint differs from now's, else null. */
export async function buildWarning(replayFile, cfg, root) {
  const rec = recordedBuild(replayFile);
  if (!rec) return null;
  const now = await fingerprint(cfg, root).catch(() => null);
  if (!now) return null;
  const d = buildDiff(rec, now);
  return d ? `⚠ the build changed since this playtest (${d}): the replay may not match what the tester saw` : null;
}
