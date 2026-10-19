// A fake `claude -p` for testing `witness play batch` without a model (WITNESS_CLAUDE=<this file>). It reads the brief
// on stdin and runs the brief's own commands, exactly as written, through sh (as Claude Code's Bash tool would):
//   - a goal containing "block-once": the first attempt starts the session, then is "denied" `cd <registry> && ./name`
//     (the 0.7.1 failure) and gives up; the retry (the prompt names the blocked command) plays one order and ENDs.
//   - "block-always": every attempt is denied.
//   - otherwise: start, one order, end.
// It prints claude's JSON result line ({result, permission_denials, num_turns, total_cost_usd}).
import { spawnSync } from "node:child_process";

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const d of process.stdin) prompt += d;
const grab = (label) => { const m = new RegExp(`^  ${label}:\\s+(.+)$`, "m").exec(prompt); return m ? m[1].trim() : null; };
const start = grab("start"), order = grab("order");
const shim = order ? order.replace(/ "<orders>"$/, "") : null;
const goal = (/^GOAL: (.*)$/m.exec(prompt) || [])[1] || "";
const retry = /A PREVIOUS ATTEMPT WAS BLOCKED/.test(prompt);
const sh = (cmd) => { const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: 120000, windowsHide: true }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
const out = (o) => { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.001, permission_denials: [], ...o })); process.exit(0); };

const log = [];
if (!start || !shim) out({ result: `no start/order command in the brief: ${prompt.slice(0, 200)}` });
const s = sh(start); log.push(`start → ${s.code}`);
if (/block-always/.test(goal) || (/block-once/.test(goal) && !retry)) {
  const name = shim.replace(/"/g, "").split("/").pop();
  const denied = `cd "${shim.replace(/"/g, "").split("/").slice(0, -1).join("/")}" && ./${name} "goto Coin"`;
  out({ result: "I was blocked: the command was denied by the permission mode, and I won't work around it.", permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_fake", tool_input: { command: denied } }] });
}
const o = sh(`${shim} "pickup coin"`); log.push(`order → ${o.code}: ${o.out.split("\n")[0]}`);
const e = sh(`${shim} end --fun 3 --difficulty 2 --feedback "fake tester"`); log.push(`end → ${e.code}: ${e.out.split("\n")[0]}`);
out({ result: log.join("\n") });
