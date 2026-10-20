// JS adapter (Node, TCP): a command whose multibyte UTF-8 characters arrive split across TCP chunks must decode
// intact (regression: each chunk was decoded alone, so a split "é" / emoji became U+FFFD).
// Run: node tests/js-adapter/utf8-split.mjs   (exits 1 on failure; one short-lived child process)
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = pathToFileURL(path.join(here, "..", "..", "adapters", "js", "witness.js")).href;
const TEXT = "héllo 😀 ✓";
const game = `import witness from ${JSON.stringify(adapter)};
await witness.start({ name: "utf8", fps: 60, snapshot: () => ({}), calls: { echo: (s) => s } });`;

let child, done = false;
const finish = (ok, msg) => {
  if (done) return;
  done = true;
  console.log(`${ok ? "ok  " : "FAIL"} js adapter: ${msg}`);
  try { child && child.kill(); } catch { /* gone */ }
  server.close();
  process.exitCode = ok ? 0 : 1;
};
const server = net.createServer((sock) => {
  let buf = "";
  sock.on("error", () => {});   // the game quits / is killed
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf("\n")) >= 0;) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.hello) {
        // the command's bytes in two writes, cut inside the emoji's 4-byte sequence
        const bytes = Buffer.from(JSON.stringify({ id: 1, cmd: "call", name: "echo", args: [TEXT] }) + "\n", "utf8");
        const cut = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;
        sock.write(bytes.subarray(0, cut));
        setTimeout(() => sock.write(bytes.subarray(cut)), 100);
      } else if (msg.id === 1) {
        finish(msg.ok !== false && msg.result === TEXT, `split multibyte chars decode intact (got ${JSON.stringify(msg.result ?? msg.error)})`);
        sock.write(JSON.stringify({ id: 2, cmd: "quit" }) + "\n");
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  const addr = `127.0.0.1:${server.address().port}`;
  child = spawn(process.execPath, ["--input-type=module", "-e", game], { env: { ...process.env, WITNESS_ADDR: addr }, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  child.on("exit", () => finish(false, "the game exited before replying"));
});
setTimeout(() => finish(false, "timed out"), 20000).unref();
