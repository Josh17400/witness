// JS adapter (Node, TCP): the OS key's other spellings ("super", "command", "win", "windows") arrive as "meta", as
// in the C++/Rust/Go/C#/Godot adapters (regression: "super" was an unknown key in JS, so shared scripts diverged).
// Run: node tests/js-adapter/key-aliases.mjs   (exits 1 on failure; one short-lived child process)
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = pathToFileURL(path.join(here, "..", "..", "adapters", "js", "witness.js")).href;
const NAMES = ["super", "command", "win", "windows", "cmd", "meta"];
const game = `import witness from ${JSON.stringify(adapter)};
const seen = [];
await witness.start({ name: "keys", fps: 60, snapshot: () => ({ seen, held: [...witness.input.keys] }),
  input: (ev) => { if (ev.type === "key") seen.push(ev.key); } });`;

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
  const send = (o) => sock.write(JSON.stringify(o) + "\n");
  sock.on("error", () => {});   // the game quits / is killed
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf("\n")) >= 0;) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.hello) {
        send({ id: 1, cmd: "input", events: NAMES.map((key) => ({ frame: 0, type: "key", key, down: true })) });
        send({ id: 2, cmd: "step", frames: 1 });
        send({ id: 3, cmd: "snapshot" });
      } else if (msg.id === 3) {
        const held = (msg.state && msg.state.held) || [];
        finish(msg.ok !== false && held.length === 1 && held[0] === "meta",
          `super/command/win/windows/cmd all hold "meta" (held ${JSON.stringify(held)}, delivered ${JSON.stringify(msg.state && msg.state.seen)})`);
        send({ id: 4, cmd: "quit" });
      } else if (msg.ok === false) finish(false, `command ${msg.id} failed: ${msg.error}`);
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  const addr = `127.0.0.1:${server.address().port}`;
  child = spawn(process.execPath, ["--input-type=module", "-e", game], { env: { ...process.env, WITNESS_ADDR: addr }, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  child.on("exit", () => finish(false, "the game exited before replying"));
});
setTimeout(() => finish(false, "timed out"), 20000).unref();
