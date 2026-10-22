// Browser games: launch an optional dev server, then a headless browser (Playwright: Chromium by default, WebKit for
// iPhone Safari, or Firefox) pointed at launch.url with ?witness=<addr>, so the page's adapter connects back over
// WebSocket. Optional device emulation (src/core/devices.js), an emulated audio autoplay policy (src/core/web-init.js),
// and screenshots of what the screen shows at device pixels (capture "element" / "screen").
// Playwright is an OPTIONAL dependency, resolved from the game project first, then the current folder, Witness, global.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { WitnessError } from "./session.js";
import { track, untrack } from "./procs.js";
import { resolveDevice, contextOptions, safeInsetsFor } from "./devices.js";
import { webInit, safeInsetsInit } from "./web-init.js";

export const ENGINES = ["chromium", "webkit", "firefox"];
export const CAPTURES = ["canvas", "element", "screen"];

// Where Playwright is looked for, in order: the config's folder (a config in the OS temp folder has none), WITNESS_PLAYWRIGHT,
// the current folder, Witness's own install (and the folders above it), then the global npm folder (and NODE_PATH).
function npmGlobalRoot() {
  try { const r = spawnSync("npm root -g", { shell: true, encoding: "utf8", windowsHide: true, timeout: 15000 }); return r.status === 0 ? r.stdout.trim() || null : null; } catch { return null; }
}
export async function loadPlaywright(root) {
  const where = [["the config's folder", path.join(path.resolve(root), "package.json")]];
  // WITNESS_PLAYWRIGHT: a folder with Playwright installed (node_modules/playwright), when the game project has none
  if (process.env.WITNESS_PLAYWRIGHT) where.push(["WITNESS_PLAYWRIGHT", path.join(path.resolve(process.env.WITNESS_PLAYWRIGHT), "package.json")]);
  where.push(["the current folder", path.join(process.cwd(), "package.json")], ["the Witness install", fileURLToPath(import.meta.url)]);
  const tried = new Set(), looked = [];
  // flat: base's folder holds the packages itself (a NODE_PATH entry of any name), so load <folder>/<name> by path
  const attempt = (label, base, flat = false) => {
    const dir = path.dirname(base);
    if (tried.has(dir)) return null;
    tried.add(dir);
    looked.push(`${label} (${dir})`);
    try {
      const req = createRequire(base);
      for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
        const id = flat ? path.join(dir, name) : name;
        try { const m = req(id); const pw = m.chromium ? m : m.default; let version = null; try { version = req(flat ? path.join(id, "package.json") : `${name}/package.json`).version; } catch { /* exports map */ } return { pw, version, from: path.dirname(req.resolve(id)) }; } catch { /* next */ }
      }
    } catch { /* next */ }
    return null;
  };
  for (const [label, base] of where) { const r = attempt(label, base); if (r) return r; }
  // global installs: npm i -g playwright (the global node_modules folder itself), NODE_PATH folders
  const globals = [...String(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean).map((d) => ["NODE_PATH", d]), ...[npmGlobalRoot()].filter(Boolean).map((d) => ["the global npm folder", d])];
  for (const [label, dir] of globals) { const r = attempt(label, path.join(path.resolve(dir), "package.json"), true); if (r) return r; }
  throw new WitnessError(`browser games need Playwright: run 'npm i -D playwright && npx playwright install chromium' in your project (or in the Witness folder, or 'npm i -g playwright', or point WITNESS_PLAYWRIGHT at a folder that has it). Looked in: ${looked.join(", ")}`);
}

async function waitForUrl(url, ms, child = null) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode) throw new WitnessError(`the dev server exited (code ${child.exitCode}) before answering at ${url}`);   // 0: a launcher that left it running
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new WitnessError(`the dev server never answered at ${url}`);
}

// launch.media: CSS media features emulated through Playwright (newContext + emulateMedia), so matchMedia and @media
// rules both see them: {reducedMotion: "reduce"|"no-preference", colorScheme: "dark"|"light",
// forcedColors: "active"|"none", contrast: "more"|"no-preference"}.
export const MEDIA = { reducedMotion: ["reduce", "no-preference"], colorScheme: ["dark", "light"], forcedColors: ["active", "none"], contrast: ["more", "no-preference"] };
export function mediaOptions(media) {
  if (media == null || media === false) return null;
  if (typeof media !== "object" || Array.isArray(media)) throw new WitnessError(`launch.media ${JSON.stringify(media)}: use an object such as {"reducedMotion": "reduce", "colorScheme": "dark"}`);
  const out = {};
  for (const [k, v] of Object.entries(media)) {
    if (v == null) continue;
    if (!MEDIA[k]) throw new WitnessError(`launch.media.${k}: unknown media feature (use ${Object.keys(MEDIA).join(", ")})`);
    const val = String(v).toLowerCase();
    if (!MEDIA[k].includes(val)) throw new WitnessError(`launch.media.${k} ${JSON.stringify(v)}: use ${MEDIA[k].map((x) => `"${x}"`).join(" or ")}`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : null;
}

/** launch.{engine, device, audioUnlock, capture, media} checked and resolved: {engine, device, policy, capture, media}. */
export function browserOptions(launch) {
  const engine = String(launch.engine || "chromium").toLowerCase();
  if (!ENGINES.includes(engine)) throw new WitnessError(`unknown browser engine '${launch.engine}': use chromium (default), webkit (iPhone/iPad Safari's engine) or firefox`);
  const device = resolveDevice(launch.device);
  const capture = String(launch.capture || "canvas").toLowerCase();
  if (!CAPTURES.includes(capture)) throw new WitnessError(`unknown capture '${launch.capture}': use canvas (the game's own pixels, default), element (the canvas as the screen shows it, device pixels) or screen (the whole viewport, device pixels)`);
  if (engine === "firefox" && device && device.mobile) throw new WitnessError(`Playwright's Firefox can't emulate a mobile viewport (device ${device.name}): use --engine webkit or chromium`);
  // safe areas: env(safe-area-inset-*) rewritten to the profile's insets (safeInsets), the island / home indicator /
  // corners drawn over screenshots (safeOverlay); both need a phone or tablet profile
  const safe = launch.safeInsets || launch.safeOverlay ? safeInsetsFor(device, launch.safeInsets || true) : null;
  if ((launch.safeInsets || launch.safeOverlay) && !safe) throw new WitnessError(`--safe-insets / --safe-overlay need a phone or tablet profile (--device iphone-15[-landscape], iphone-15-safari, iphone-15-pro-max, iphone-se, ipad), a custom device of a known size, or explicit insets (--safe-insets 59,0,34,0: top,right,bottom,left CSS px; or a preset name such as iphone-portrait); ${device ? `${device.name} has no safe-area preset` : "this launch has no device"}`);
  return { engine, device, policy: launch.audioUnlock === false ? "gesture" : "auto", capture, captureSet: launch.capture != null, safeInsets: launch.safeInsets ? safe : null, safeOverlay: launch.safeOverlay ? safe : null, media: mediaOptions(launch.media) };
}

/** A clear message when the engine's browser build isn't installed for this Playwright version. */
function launchError(e, engine, pwInfo, root) {
  const msg = String(e && e.message || e);
  if (/Executable doesn't exist|browserType\.launch: .*(not found|install)|please run the following command/i.test(msg)) {
    const exe = /Executable doesn't exist at ([^\n]+)/.exec(msg);
    const name = { chromium: "Chromium", webkit: "WebKit", firefox: "Firefox" }[engine];
    return new WitnessError(`${name} isn't installed for Playwright ${pwInfo.version || ""}${exe ? ` (looked for ${exe[1].trim()})` : ""}.\n` +
      `  Install it (no admin rights needed; downloaded into the per-user ms-playwright cache):\n    cd "${root}" && npx playwright install ${engine}\n` +
      (process.platform === "linux" ? `  On Linux it also needs system libraries: sudo npx playwright install-deps ${engine}\n` : "") +
      (engine === "webkit" ? "  (WebKit is the engine of every iPhone/iPad browser; Playwright's build is close to Safari, not identical.)" : ""));
  }
  return e;
}

// launch.inject: Witness's own JS adapter (adapters/js/witness.js), turned into a classic script, runs in the page
// before any of the page's scripts (Playwright addInitScript), so inline classic <script>s already run on the virtual
// clock; the page's own import of witness.js gets that same instance (globalThis.__witnessApi). Its exports are cut off.
const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters", "js", "witness.js");
export function adapterClassicScript() {
  const src = fs.readFileSync(ADAPTER, "utf8");
  const cut = src.indexOf("// ---- module exports");
  if (cut < 0) throw new WitnessError(`${ADAPTER} has no exports marker: can't inject it`);
  return `(() => {
${src.slice(0, cut)}
})();
//# sourceURL=witness-injected.js`;
}

export async function openBrowserGame(launch, root, addr, keep, extra = {}) {
  let server = null, browser = null;
  const opts = browserOptions(launch);
  try {
    if (launch.server) {
      const s = typeof launch.server === "string" ? { command: launch.server } : launch.server;
      // the server runs behind a shell, and killing the shell alone leaves the real server running (and holding its
      // port): tracked, so kill() takes the whole tree, and it dies with the CLI however that ends (src/core/procs.js)
      server = track(spawn(s.command, { cwd: path.resolve(root, s.cwd || "."), shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
      server.stdout.on("data", keep);
      server.stderr.on("data", keep);
      await waitForUrl(s.wait || launch.url, (s.timeout || 60) * 1000, server);
    }
    const pwInfo = await loadPlaywright(root);
    const type = pwInfo.pw[opts.engine];
    if (!type) throw new WitnessError(`this Playwright build has no ${opts.engine}`);
    const args = opts.engine === "chromium" ? ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] : [];
    try { browser = await type.launch({ headless: launch.headless !== false, args }); }
    catch (e) { throw launchError(e, opts.engine, pwInfo, root); }
    const context = await browser.newContext({ ...contextOptions(opts.device, launch.size || [1280, 720]), ...(opts.media || {}) });
    await context.addInitScript(webInit, { policy: opts.policy, standalone: !!(opts.device && opts.device.standalone), platform: (opts.device && opts.device.platform) || null, maxTouchPoints: opts.device && opts.device.maxTouchPoints != null ? opts.device.maxTouchPoints : null });
    if (opts.safeInsets) await context.addInitScript(safeInsetsInit, opts.safeInsets);
    if (launch.inject) {
      const adapterSrc = fs.readFileSync(ADAPTER, "utf8");
      await context.addInitScript({ content: adapterClassicScript() });
      // the page's own copy of witness.js (any version) is served as Witness's, so both are one adapter
      await context.route(/\/witness\.js(\?.*)?$/, async (route) => {
        try {
          const res = await route.fetch();
          const body = await res.text();
          if (/witness-js|Witness adapter for JavaScript/.test(body)) return route.fulfill({ response: res, body: adapterSrc, headers: { ...res.headers(), "content-type": "text/javascript" } });
          return route.fulfill({ response: res, body });
        } catch { return route.continue().catch(() => {}); }
      });
    }
    const page = await context.newPage();
    // newContext's media options cover every page and reload; emulateMedia again for builds that ignore one of them
    if (opts.media) { try { await page.emulateMedia(opts.media); } catch (e) { keep(`[witness] launch.media: this Playwright (${pwInfo.version || "?"}) couldn't emulate ${JSON.stringify(opts.media)}: ${e.message}\n`); } }
    page.on("console", (m) => keep(`[page] ${m.text()}\n`));
    page.on("pageerror", (e) => keep(`[page error] ${e.message}\n`));
    const u = new URL(launch.url);
    u.searchParams.set("witness", addr);
    for (const [k, v] of Object.entries(extra.query || {})) if (v != null) u.searchParams.set(k, String(v));
    await page.goto(u.toString());
    const web = makeWeb(page, browser, opts, pwInfo);
    web.url = u.toString();
    web.inject = !!launch.inject;
    /** Load the page again (launch.reset "reload"): same URL plus query (witness_seed …); storage cleared unless keepStorage. */
    web.reload = async (query = {}, { keepStorage = false } = {}) => {
      if (!keepStorage) {
        await page.evaluate(() => {
          try { localStorage.clear(); } catch { /* blocked */ }
          try { sessionStorage.clear(); } catch { /* blocked */ }
        }).catch(() => {});
      }
      const r = new URL(web.url);
      for (const [k, v] of Object.entries(query)) if (v != null) r.searchParams.set(k, String(v));
      await page.goto(r.toString());
    };
    return { browser, server, web };
  } catch (e) {
    // the caller never sees these on failure, so close them here (no stray browsers or servers)
    if (browser) await browser.close().catch(() => {});
    if (server) { server.kill(); untrack(server); }
    throw e;
  }
}

/** The CLI's handle on the page: what the screen shows, the audio policy, trusted (real) input. */
function makeWeb(page, browser, opts, pwInfo) {
  const evalWeb = (fn, arg) => page.evaluate(fn, arg);
  const mainCanvas = () => page.evaluateHandle(() => {
    let best = null, area = 0;
    for (const c of document.querySelectorAll("canvas")) { const r = c.getBoundingClientRect(); if (r.width * r.height > area) { area = r.width * r.height; best = c; } }
    return best;
  });
  return {
    engine: opts.engine, engineVersion: browser.version(), playwright: pwInfo.version, device: opts.device, policy: opts.policy, captureMode: opts.capture, captureSet: opts.captureSet, page,
    safeInsets: opts.safeInsets, safeOverlay: opts.safeOverlay, media: opts.media,
    /** launch.media: what the page's matchMedia says for each emulated feature (null: none emulated). */
    mediaInfo: () => (opts.media ? evalWeb((m) => {
      const q = { reducedMotion: "prefers-reduced-motion", colorScheme: "prefers-color-scheme", forcedColors: "forced-colors", contrast: "prefers-contrast" };
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, matchMedia(`(${q[k]}: ${v})`).matches]));
    }, opts.media) : Promise.resolve(null)),
    /** --safe-insets: what the page's CSS had rewritten so far (null: not emulated). */
    safeInfo: () => (opts.safeInsets ? evalWeb(() => (globalThis.__witnessSafe ? globalThis.__witnessSafe.info() : null)) : Promise.resolve(null)),
    info: () => evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.info() : null)),
    audio: () => evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.audio() : null)),
    webgl: () => evalWeb(() => (globalThis.__witnessWeb && globalThis.__witnessWeb.webgl ? globalThis.__witnessWeb.webgl() : null)),
    unlock: () => evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.unlock() : 0)),
    /** Compact facts for expressions: web.dpr, web.device, web.audio.state, web.audio.running ... */
    async state() {
      const i = await evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.info() : null));
      if (!i) return null;
      return { engine: opts.engine, device: opts.device ? opts.device.name : null, dpr: i.dpr, viewport: i.viewport, standalone: i.standalone, touch: i.maxTouchPoints > 0, audio: i.audio, media: opts.media || null };
    },
    /** PNG of the main canvas as displayed (element) or of the viewport (screen), at device pixels. */
    async capture(kind = "element") {
      let png;
      // Playwright's animations: "disabled" finishes every finite CSS animation / transition for good (firing its
      // end event): it would change the game. With the JS adapter's takeover animations sit still on the virtual clock.
      const held = await page.evaluate(() => typeof globalThis.__witnessAnimating === "function").catch(() => false);
      const animations = held ? "allow" : "disabled";
      if (kind === "screen") png = await page.screenshot({ type: "png", animations, caret: "hide" });
      else {
        const h = await mainCanvas();
        const el = h.asElement();
        if (!el) throw new WitnessError("no visible <canvas> on the page to capture");
        png = await el.screenshot({ type: "png", animations, caret: "hide" });
      }
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    },
    /** Trusted input through the browser (not the adapter): {kind: "tap"|"click"|"key", x, y, key}; x/y in game pixels. */
    async dom(ev, size) {
      if (ev.kind === "key") { await page.keyboard.press(domKey(ev.key)); return; }
      const p = await page.evaluate(([x, y, sz]) => {
        let best = null, area = 0;
        for (const c of document.querySelectorAll("canvas")) { const r = c.getBoundingClientRect(); if (r.width * r.height > area) { area = r.width * r.height; best = c; } }
        if (!best) return [x, y];
        const r = best.getBoundingClientRect(), w = sz ? sz[0] : best.width, h = sz ? sz[1] : best.height;
        return [r.left + (x * r.width) / w, r.top + (y * r.height) / h];
      }, [ev.x, ev.y, size || null]);
      // dom:tap on a desktop viewport (no touch screen): a mouse click at the same point, said once
      if (ev.kind === "tap" && !(opts.device && opts.device.touch)) {
        if (!this.tapWarned) { this.tapWarned = true; process.stderr.write("⚠ dom:tap on a desktop viewport (no touch screen): sent as a mouse click at the same point (--device iphone-15 for real touches, or dom:click)\n"); }
        await page.mouse.click(p[0], p[1]);
      } else if (ev.kind === "tap") await page.touchscreen.tap(p[0], p[1]);
      else await page.mouse.click(p[0], p[1]);
    },
  };
}

const DOM_KEYS = { space: " ", enter: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", backspace: "Backspace", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", shift: "Shift", ctrl: "Control", alt: "Alt" };
function domKey(k) { const n = String(k).toLowerCase(); return DOM_KEYS[n] || (/^f\d+$/.test(n) ? n.toUpperCase() : n); }

