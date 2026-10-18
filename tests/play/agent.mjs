// A scripted "fake agent": drives a whole playtest through the witness CLI, exactly as a tester subagent would.
//   node tests/play/agent.mjs <gameDir> <name> "<order>" "<order>" ... [--start "<extra start args>"] [--end "<end args>"] [--quiet]
// Prints every observation (unless --quiet), ends the session, and prints the end summary. Exit code 0 when every
// command ran. Used by tests/play/e2e.mjs and for reproducing a tester's session order by order.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "..", "bin", "witness.js");

export function witness(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 300000, env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/** Run a session: start → orders → end. Returns {start, steps: [{order, code, out}], end}. */
export function playSession({ dir, name, orders, startArgs = [], endArgs = [], env = {}, quiet = true, log = console.log }) {
  const run = (args) => witness(args, { cwd: dir, env });
  const start = run(["play", "start", "--name", name, ...startArgs]);
  if (!quiet) log(`$ play start ${startArgs.join(" ")}\n${start.out}`);
  const steps = [];
  if (start.code === 0) {
    for (const o of orders) {
      const args = Array.isArray(o) ? o : ["play", "do", o, "-s", name];
      const r = run(args);
      steps.push({ order: o, ...r });
      if (!quiet) log(`$ ${Array.isArray(o) ? o.join(" ") : `do "${o}"`}  (exit ${r.code})\n${r.out}`);
    }
  }
  const end = run(["play", "end", "-s", name, ...endArgs]);
  if (!quiet) log(`$ play end\n${end.out}`);
  return { start, steps, end };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const quiet = argv.includes("--quiet"); if (quiet) argv.splice(argv.indexOf("--quiet"), 1);
  const startExtra = take("--start"), endExtra = take("--end");
  const [dir, name, ...orders] = argv;
  if (!dir || !name) { console.error('usage: node tests/play/agent.mjs <gameDir> <name> "<order>" ... [--start "..."] [--end "..."] [--quiet]'); process.exit(2); }
  const split = (s) => (s ? s.match(/"[^"]*"|\S+/g).map((x) => x.replace(/^"|"$/g, "")) : []);
  const r = playSession({ dir: path.resolve(dir), name, orders, startArgs: split(startExtra), endArgs: split(endExtra), quiet });
  process.exit(r.start.code === 0 && r.end.code === 0 ? 0 : 1);
}
