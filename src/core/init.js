// `witness init`: detect the project's language/engine, install the matching adapter, write
// witness.json + a starter test + the adapter guide, and install the Claude skill.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_NAME } from "./launch.js";

export function listAdapters(root) {
  const dir = path.join(root, "adapters");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((id) => path.join(dir, id, "adapter.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => { const a = JSON.parse(fs.readFileSync(f, "utf8")); a.dir = path.dirname(f); a.id = a.id || path.basename(a.dir); return a; })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// "src/**/*.cpp" → RegExp over forward-slash relative paths
function globRe(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp(`^${re}$`, "i");
}

function listFiles(root, maxDepth = 4, cap = 20000) {
  const out = [];
  const SKIP = new Set(["node_modules", ".git", "build", "dist", "target", "bin", "obj", "Library", "Temp", ".godot", "__pycache__", ".venv", "venv"]);
  const walk = (d, rel, depth) => {
    if (depth > maxDepth || out.length > cap) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") && e.name !== ".claude") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(d, e.name), r, depth + 1); }
      else out.push(r);
    }
  };
  walk(root, "", 0);
  return out;
}

export function detect(project, adapters) {
  const files = listFiles(project);
  const set = new Set(files.map((f) => f.toLowerCase()));
  const scores = adapters.map((a) => {
    const d = a.detect || {};
    let score = 0;
    const why = [];
    for (const f of d.files || []) if (set.has(f.toLowerCase())) { score += 3; why.push(f); }
    for (const g of d.globs || []) { const re = globRe(g); const hit = files.find((f) => re.test(f)); if (hit) { score += 2; why.push(hit); } }
    for (const c of d.contains || []) {
      const re = globRe(c.glob);
      const hit = files.filter((f) => re.test(f)).slice(0, 20).find((f) => { try { return fs.readFileSync(path.join(project, f), "utf8").includes(c.text); } catch { return false; } });
      if (hit) { score += 4; why.push(`${hit} mentions ${c.text}`); }
    }
    return { adapter: a, score: score * (a.priority || 1), why };
  }).filter((s) => s.score > 0).sort((x, y) => y.score - x.score);
  return scores;
}

export async function init(project, opt, ROOT) {
  const adapters = listAdapters(ROOT);
  if (!adapters.length) { console.error("✖ no adapters are bundled with this Witness install"); process.exit(1); }
  let pick;
  if (opt.lang && opt.lang !== true) {
    pick = adapters.find((a) => a.id === opt.lang || (a.languages || []).includes(opt.lang));
    if (!pick) { console.error(`✖ no adapter '${opt.lang}'. Available: ${adapters.map((a) => a.id).join(", ")}`); process.exit(1); }
  } else {
    const ranked = detect(project, adapters);
    if (!ranked.length) {
      console.log(`Couldn't tell what this project is built with. Pick one with --lang:\n${adapters.map((a) => `  ${a.id.padEnd(14)} ${a.title}`).join("\n")}`);
      process.exit(1);
    }
    pick = ranked[0].adapter;
    console.log(`▸ detected ${pick.title} (${ranked[0].why.slice(0, 3).join(", ")})${ranked[1] ? `; also possible: ${ranked.slice(1, 3).map((r) => r.adapter.id).join(", ")} (use --lang to choose)` : ""}`);
  }

  const wrote = [], kept = [];
  const put = (to, content) => {
    const dest = path.join(project, to);
    if (fs.existsSync(dest) && !opt.force) { kept.push(to); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(dest, content); else fs.writeFileSync(dest, content);
    wrote.push(to);
  };
  for (const f of pick.install || []) {
    const src = path.join(pick.dir, f.from);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) {
      for (const rel of listFiles(src, 8)) put(path.join(f.to, rel), fs.readFileSync(path.join(src, rel)));
    } else put(f.to, fs.readFileSync(src));
  }
  // integration guide, kept next to the tests so Claude can read it in-project
  if (pick.guide && fs.existsSync(path.join(pick.dir, pick.guide))) put("witness/ADAPTER-GUIDE.md", fs.readFileSync(path.join(pick.dir, pick.guide)));
  put(CONFIG_NAME, JSON.stringify({
    name: path.basename(project),
    adapter: pick.id,
    launch: pick.launch || { command: "./path/to/your/game", args: [] },
    build: pick.build || null,
    tests: "witness",
    seed: 1,
  }, null, 2) + "\n");
  put("witness/smoke.witness.json", JSON.stringify([
    { name: "the game boots, steps and reports state", steps: [{ at: 1, expect: ["frame >= 60", "state != null"] }] },
  ], null, 2) + "\n");
  put("witness/.gitignore", "shots/\nreplays/\nplaytests/\n");
  // Claude skills (project-local copies, with the CLI path filled in): the main skill and the playtester's
  for (const skill of ["witness", "witness-playtester"]) {
    const skillSrc = path.join(ROOT, "skills", skill, "SKILL.md");
    if (!fs.existsSync(skillSrc) || opt["no-skill"]) continue;
    const cli = path.join(ROOT, "bin", "witness.js").replace(/\\/g, "/");
    put(`.claude/skills/${skill}/SKILL.md`, fs.readFileSync(skillSrc, "utf8").replaceAll("${CLAUDE_PLUGIN_ROOT}/bin/witness.js", cli).replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT.replace(/\\/g, "/")));
  }

  for (const w of wrote) console.log(`  + ${w}`);
  for (const k of kept) console.log(`  = ${k} (exists; --force to overwrite)`);
  console.log(`
✔ Witness is set up for ${pick.title}${pick.verified === false ? "  (note: this adapter is not yet verified by automated runs)" : ""}.
Next (Claude can do all of this):
  1. Wire the adapter into the game by following witness/ADAPTER-GUIDE.md
     (connect when WITNESS_ADDR is set, step only on command, expose state, seed the RNG).
  2. Fix "launch" in ${CONFIG_NAME} so it starts the built game.
  3. Run:  witness doctor      then write tests in witness/*.witness.json and run  witness test
  4. Optional: agent playtests, a cheap model plays the game and reports:  witness play suggest  (witness help play)`);
}
