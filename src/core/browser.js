// Browser games: launch an optional dev server, then a headless browser (Playwright: Chromium by default, WebKit for
// iPhone Safari, or Firefox) pointed at launch.url with ?witness=<addr>, so the page's adapter connects back over
// WebSocket. Optional device emulation (src/core/devices.js), an emulated audio autoplay policy (src/core/web-init.js),
// and screenshots of what the screen shows at device pixels (capture "element" / "screen").
// Playwright is an OPTIONAL dependency, resolved from the game project first, then from Witness.
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { WitnessError } from "./session.js";
import { resolveDevice, contextOptions } from "./devices.js";
import { webInit } from "./web-init.js";

export const ENGINES = ["chromium", "webkit", "firefox"];
export const CAPTURES = ["canvas", "element", "screen"];

async function loadPlaywright(root) {
  // WITNESS_PLAYWRIGHT: a folder with Playwright installed (node_modules/playwright), when the game project has none
  const extra = process.env.WITNESS_PLAYWRIGHT ? [path.join(path.resolve(process.env.WITNESS_PLAYWRIGHT), "package.json")] : [];
  for (const base of [path.join(root, "package.json"), ...extra, import.meta.url]) {
    try {
      const req = createRequire(base);
      for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
        try { const m = req(name); const pw = m.chromium ? m : m.default; let version = null; try { version = req(`${name}/package.json`).version; } catch { /* exports map */ } return { pw, version, from: path.dirname(req.resolve(name)) }; } catch { /* next */ }
      }
    } catch { /* next */ }
  }
  throw new WitnessError("browser games need Playwright: run 'npm i -D playwright && npx playwright install chromium' in your project (or in the Witness folder, or point WITNESS_PLAYWRIGHT at a folder that has it)");
}

async function waitForUrl(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new WitnessError(`the dev server never answered at ${url}`);
}

// The server runs behind a shell, and killing the shell alone leaves the real server running
// (and holding its port, so the next run talks to a dying server). Make kill() take the whole tree.
function killTree(child) {
  child.kill = () => {
    if (child.exitCode !== null || child.pid == null) return false;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } }
    return true;
  };
}

/** launch.{engine, device, audioUnlock, capture} checked and resolved: {engine, device, policy, capture}. */
export function browserOptions(launch) {
  const engine = String(launch.engine || "chromium").toLowerCase();
  if (!ENGINES.includes(engine)) throw new WitnessError(`unknown browser engine '${launch.engine}': use chromium (default), webkit (iPhone/iPad Safari's engine) or firefox`);
  const device = resolveDevice(launch.device);
  const capture = String(launch.capture || "canvas").toLowerCase();
  if (!CAPTURES.includes(capture)) throw new WitnessError(`unknown capture '${launch.capture}': use canvas (the game's own pixels, default), element (the canvas as the screen shows it, device pixels) or screen (the whole viewport, device pixels)`);
  if (engine === "firefox" && device && device.mobile) throw new WitnessError(`Playwright's Firefox can't emulate a mobile viewport (device ${device.name}): use --engine webkit or chromium`);
  return { engine, device, policy: launch.audioUnlock === false ? "gesture" : "auto", capture };
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

export async function openBrowserGame(launch, root, addr, keep) {
  let server = null, browser = null;
  const opts = browserOptions(launch);
  try {
    if (launch.server) {
      const s = typeof launch.server === "string" ? { command: launch.server } : launch.server;
      server = spawn(s.command, { cwd: path.resolve(root, s.cwd || "."), shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      killTree(server);
      server.stdout.on("data", keep);
      server.stderr.on("data", keep);
      await waitForUrl(s.wait || launch.url, (s.timeout || 60) * 1000);
    }
    const pwInfo = await loadPlaywright(root);
    const type = pwInfo.pw[opts.engine];
    if (!type) throw new WitnessError(`this Playwright build has no ${opts.engine}`);
    const args = opts.engine === "chromium" ? ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] : [];
    try { browser = await type.launch({ headless: launch.headless !== false, args }); }
    catch (e) { throw launchError(e, opts.engine, pwInfo, root); }
    const context = await browser.newContext(contextOptions(opts.device, launch.size || [1280, 720]));
    await context.addInitScript(webInit, { policy: opts.policy, standalone: !!(opts.device && opts.device.standalone), platform: (opts.device && opts.device.platform) || null, maxTouchPoints: opts.device && opts.device.maxTouchPoints != null ? opts.device.maxTouchPoints : null });
    const page = await context.newPage();
    page.on("console", (m) => keep(`[page] ${m.text()}\n`));
    page.on("pageerror", (e) => keep(`[page error] ${e.message}\n`));
    const u = new URL(launch.url);
    u.searchParams.set("witness", addr);
    await page.goto(u.toString());
    const web = makeWeb(page, browser, opts, pwInfo);
    return { browser, server, web };
  } catch (e) {
    // the caller never sees these on failure, so close them here (no stray browsers or servers)
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
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
    engine: opts.engine, engineVersion: browser.version(), playwright: pwInfo.version, device: opts.device, policy: opts.policy, captureMode: opts.capture, page,
    info: () => evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.info() : null)),
    audio: () => evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.audio() : null)),
    webgl: () => evalWeb(() => (globalThis.__witnessWeb && globalThis.__witnessWeb.webgl ? globalThis.__witnessWeb.webgl() : null)),
    unlock: () => evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.unlock() : 0)),
    /** Compact facts for expressions: web.dpr, web.device, web.audio.state, web.audio.running ... */
    async state() {
      const i = await evalWeb(() => (globalThis.__witnessWeb ? globalThis.__witnessWeb.info() : null));
      if (!i) return null;
      return { engine: opts.engine, device: opts.device ? opts.device.name : null, dpr: i.dpr, viewport: i.viewport, standalone: i.standalone, touch: i.maxTouchPoints > 0, audio: i.audio };
    },
    /** PNG of the main canvas as displayed (element) or of the viewport (screen), at device pixels. */
    async capture(kind = "element") {
      let png;
      if (kind === "screen") png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
      else {
        const h = await mainCanvas();
        const el = h.asElement();
        if (!el) throw new WitnessError("no visible <canvas> on the page to capture");
        png = await el.screenshot({ type: "png", animations: "disabled", caret: "hide" });
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
      if (ev.kind === "tap") {
        if (!(opts.device && opts.device.touch)) throw new WitnessError("dom:tap needs a touch device (--device iphone-15, or a custom device with \"touch\": true); use dom:click on desktop");
        await page.touchscreen.tap(p[0], p[1]);
      } else await page.mouse.click(p[0], p[1]);
    },
  };
}

const DOM_KEYS = { space: " ", enter: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", backspace: "Backspace", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", shift: "Shift", ctrl: "Control", alt: "Alt" };
function domKey(k) { const n = String(k).toLowerCase(); return DOM_KEYS[n] || (/^f\d+$/.test(n) ? n.toUpperCase() : n); }

