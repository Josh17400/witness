// Browser games: launch an optional dev server, then a headless Chromium (Playwright) pointed at
// launch.url with ?witness=<addr> so the page's adapter connects back over WebSocket.
// Playwright is an OPTIONAL dependency, resolved from the game project first, then from Witness.
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { WitnessError } from "./session.js";

async function loadPlaywright(root) {
  for (const base of [path.join(root, "package.json"), import.meta.url]) {
    try {
      const req = createRequire(base);
      for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
        try { const m = req(name); return m.chromium ? m : m.default; } catch { /* next */ }
      }
    } catch { /* next */ }
  }
  throw new WitnessError("browser games need Playwright: run 'npm i -D playwright && npx playwright install chromium' in your project (or in the Witness folder)");
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

export async function openBrowserGame(launch, root, addr, keep) {
  let server = null, browser = null;
  try {
    if (launch.server) {
      const s = typeof launch.server === "string" ? { command: launch.server } : launch.server;
      server = spawn(s.command, { cwd: path.resolve(root, s.cwd || "."), shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      killTree(server);
      server.stdout.on("data", keep);
      server.stderr.on("data", keep);
      await waitForUrl(s.wait || launch.url, (s.timeout || 60) * 1000);
    }
    const pw = await loadPlaywright(root);
    browser = await pw.chromium.launch({ headless: launch.headless !== false, args: ["--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
    const size = launch.size || [1280, 720];
    const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
    page.on("console", (m) => keep(`[page] ${m.text()}\n`));
    page.on("pageerror", (e) => keep(`[page error] ${e.message}\n`));
    const u = new URL(launch.url);
    u.searchParams.set("witness", addr);
    await page.goto(u.toString());
    return { browser, server };
  } catch (e) {
    // the caller never sees these on failure, so close them here (no stray Chromium or servers)
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    throw e;
  }
}
