// Record a real (trusted-input) session in headless Chromium with ?witness_record, then check
// that `witness replay` lands on exactly the same player position. Used by CI; needs Playwright.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const replays = path.join(here, "witness", "replays");
fs.rmSync(replays, { recursive: true, force: true });
const server = spawn(process.execPath, ["serve.mjs"], { cwd: here, stdio: "ignore", windowsHide: true });
const browser = await chromium.launch({ headless: true });
let code = 1;
try {
  for (let i = 0; i < 50 && !(await fetch("http://127.0.0.1:5317/").then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5317/?witness_record=/__witness/record&witness_seed=4");
  // wait until frames really run (headless Chromium can take a moment to start them)
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction((t) => performance.now() > t + 100, t0, { timeout: 15000 });
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1200);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("F8");
  await page.waitForTimeout(400);
  const live = await page.evaluate(() => window.coins.state());
  // post everything recorded so far (F9 does the same in download mode), then close
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/__witness/record"), { timeout: 5000 }),
    page.evaluate(() => import("./witness/witness.js").then((m) => m.default.saveRecording())),
  ]);
  await page.close();
  const file = path.join(replays, fs.readdirSync(replays)[0]);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const x = live.player.pos[0].toFixed(4);
  console.log(`recorded ${lines.length - 1} frames, live: player x=${x} score=${live.score}, F8 mark: ${lines.some((l) => l.includes('"mark":"F8"'))}`);
  const r = spawnSync(process.execPath, [path.join(here, "..", "..", "bin", "witness.js"), "replay", file, "--watch", "state.player.pos[0].toFixed(4)"], { cwd: here, encoding: "utf8" });
  process.stdout.write(r.stdout.split("\n").filter((l) => l.includes("toFixed")).slice(-1).join("\n") + "\n");
  code = r.status === 0 && r.stdout.includes(`"${x}"`) && lines.some((l) => l.includes('"mark":"F8"')) ? 0 : 1;
  console.log(code ? "✖ the replay did not reproduce the live session" : "✔ the replay reproduces the live session exactly");
} finally {
  await browser.close();
  server.kill();
}
process.exit(code);
