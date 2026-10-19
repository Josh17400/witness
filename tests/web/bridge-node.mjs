// Runs a native test build of witness.h's web bridge (bridge_host.c + a game, compiled with WITNESS_WEB_BRIDGE) with
// the REAL adapters/cpp/witness_emscripten.js in this Node process standing in for the browser page:
//   game exe  <-stdin/stdout->  this script (the EM_JS functions, a fake wasm heap)  <-WebSocket->  witness CLI
// Usage (as a witness.json launch command): node bridge-node.mjs <game exe>   (WITNESS_ADDR comes from the CLI)
// BRIDGE_STATS=<file>: at exit, write {gestures, opened, sends} there (for the tests).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shimFile = path.join(here, "..", "..", "adapters", "cpp", "witness_emscripten.js");
const stats = { gestures: 0, gestureDepthMax: 0, opened: 0, sends: 0, hello: null };
let depth = 0;
// the page's audio-policy registry, as the CLI's init script would install it: only gestures are counted here
globalThis.__witnessWeb = { begin() { depth++; stats.gestures++; stats.gestureDepthMax = Math.max(stats.gestureDepthMax, depth); }, end() { depth--; } };
vm.runInThisContext(fs.readFileSync(shimFile, "utf8"), { filename: shimFile });
const W = globalThis.WitnessEmscripten;

// the fake wasm heap: grows like Emscripten's (a new, bigger view each time), so the shim must re-read heap()
let heap = new Uint8Array(1 << 16);
const game = spawn(process.argv[2], process.argv.slice(3), { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const toGame = (s) => game.stdin.write(s);
const c = {
  heap: () => heap,
  inbuf: (n) => { if (n + 64 > heap.length) { const h = new Uint8Array(Math.max(heap.length * 2, n + 64)); h.set(heap); heap = h; } return 16; },
  recv: (n) => { toGame(`recv ${n}\n`); game.stdin.write(Buffer.from(heap.subarray(16, 16 + n))); return 1; },
  closed: () => toGame("closed\n"),
};

let buf = "", pendingSend = false;
game.stdout.setEncoding("utf8");
game.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (pendingSend) {
      pendingSend = false;
      const bytes = new TextEncoder().encode(line);   // as EM_JS passes it: a pointer into the heap and a length
      const at = 1024;
      if (at + bytes.length > heap.length) { const h = new Uint8Array(at + bytes.length + 1024); h.set(heap.subarray(0, at)); heap = h; }
      heap.set(bytes, at);
      stats.sends++;
      if (!stats.hello && line.startsWith("{\"hello\"")) stats.hello = JSON.parse(line).hello;
      W.send(heap, at, bytes.length);
      continue;
    }
    if (!line) continue;
    if (line === "active") toGame(`ret ${W.active() ? 1 : 0}\n`);
    else if (line === "open") { stats.opened++; toGame(`ret ${W.open(c) ? 1 : 0}\n`); }
    else if (line.startsWith("send ")) pendingSend = true;
    else if (line === "close") W.close();
    else if (line.startsWith("gesture ")) W.gesture(line.endsWith("1") ? 1 : 0);
    else process.stderr.write(`[bridge-node] ${line}\n`);
  }
});
game.on("exit", (code) => {
  if (process.env.BRIDGE_STATS) fs.writeFileSync(process.env.BRIDGE_STATS, JSON.stringify(stats));
  W.close();
  process.exit(code ?? 0);
});
