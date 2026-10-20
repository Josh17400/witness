// Witness CLI: the command line -> { pos, opt }. "--k v" sets opt.k = "v"; a flag with no value is true.
// flags that never take a value (and every --no-*), so the next word stays a positional ('test --json a.witness.json' runs that file)
const BOOL_FLAGS = new Set(["json", "build", "attach", "keys", "summary", "sheet", "annotate", "resize", "no-align", "wav", "no-input-events",
  "state", "shot", "no-shots", "no-audio", "no-pixels", "hold-camera", "y-up", "no-chart", "pixels", "no-images", "no-state",
  "safe-insets", "safe-overlay", "no-auto-unlock", "auto-unlock", "all", "playtests", "replays", "shots", "movies", "force", "no-skill", "help",
  "hist", "no-map", "no-prune", "allow-calls", "dry-run", "live", "turns", "bug", "confusing", "idea", "wait",
  "picture", "dominant", "write", "clean"]);
// per command: the same name takes a value elsewhere (measure ui --fit contain; trace --watch "expr")
const CMD_BOOL = { shot: ["fit"], play: ["watch"] };
// optional values: taken only when the next word looks like one (--repeat [N], --auto [N]; play note --fun "text" vs play end --fun 4)
const OPT_VALUE = { repeat: /^\d+$/, auto: /^\d+$/, fun: /^\d+(\.\d+)?$/ };
export function parseArgs(argv, cmd = "") {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), nxt = argv[i + 1];
      const flag = BOOL_FLAGS.has(k) || k.startsWith("no-") || (CMD_BOOL[cmd] || []).includes(k) || (OPT_VALUE[k] && nxt !== undefined && !OPT_VALUE[k].test(nxt));
      if (!flag && nxt !== undefined && !nxt.startsWith("--") && !/^-[a-z]/i.test(nxt)) { opt[k] = nxt; i++; } else opt[k] = true;
    } else if (a === "-o") opt.out = argv[++i];
    else if (a === "-s") opt.s = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}
