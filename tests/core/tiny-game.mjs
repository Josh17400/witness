// A tiny Witness game for core tests: a counter that steps, with switches for adapter shapes the mock doesn't cover.
//   TINY_NORESET=1   no 'reset' capability (the CLI must restart the process for each test)
//   TINY_LOGCLEAR=1  'reset' clears the log buffer (like the python/lua/godot adapters); stepping past frame 5
//                    logs an error, so a reset right after loses it unless the CLI read the logs first
//   TINY_SPLIT=1     every reply is written in two halves cut inside a multi-byte UTF-8 character ("é")
//   TINY_PID_FILE=f  appends this process's pid to f (to count launches)
//   TINY_QUIT_FILE=f appends this process's pid to f when it gets 'quit' (a clean stop, not a kill)
//   TINY_HANG=1      never answers 'step' (a command stays busy until it is killed)
import net from "node:net";
import fs from "node:fs";

const [host, port] = String(process.env.WITNESS_ADDR || "127.0.0.1:7357").split(":");
if (process.env.TINY_PID_FILE) fs.appendFileSync(process.env.TINY_PID_FILE, `${process.pid}\n`);
let frame = 0, logs = [], boots = 1;
const caps = ["step", "snapshot", "logs", "input", ...(process.env.TINY_NORESET ? [] : ["reset"])];
const sock = net.connect(+port, host);
const send = (o) => {
  const buf = Buffer.from(JSON.stringify(o) + "\n", "utf8");
  if (!process.env.TINY_SPLIT) { sock.write(buf); return; }
  const i = buf.indexOf(Buffer.from("é", "utf8"));
  if (i < 0) { sock.write(buf); return; }
  sock.write(buf.subarray(0, i + 1));   // the first byte of "é" only
  setTimeout(() => sock.write(buf.subarray(i + 1)), 15);
};
sock.on("connect", () => send({ hello: { protocol: 1, name: "Tiny", engine: "node", language: "javascript", fps: 60, capabilities: caps } }));
let buf = "";
sock.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    const reply = (o) => send({ id: m.id, ok: true, ...o });
    switch (m.cmd) {
      case "reset": frame = 0; boots++; if (process.env.TINY_LOGCLEAR) logs = []; reply({}); break;
      case "step": if (process.env.TINY_HANG) break; for (let i = 0; i < m.frames; i++) { frame++; if (frame === 6 && process.env.TINY_LOGCLEAR) logs.push({ frame, level: "error", message: "tiny: frame 6 broke" }); } reply({ frame, time: frame / 60 }); break;
      case "snapshot": reply({ frame, time: frame / 60, state: { frame, name: "café", pid: process.pid, boots } }); break;
      case "input": reply({}); break;
      case "logs": reply({ logs: logs.splice(0) }); break;
      case "quit": if (process.env.TINY_QUIT_FILE) fs.appendFileSync(process.env.TINY_QUIT_FILE, `${process.pid}\n`); reply({}); setTimeout(() => process.exit(0), 10); break;
      default: send({ id: m.id, ok: false, error: `unknown ${m.cmd}` });
    }
  }
});
sock.on("close", () => process.exit(0));
sock.on("error", () => process.exit(1));
