// Witness CLI: the command line -> { pos, opt }. "--k v" sets opt.k = "v"; a flag with no value is true.
// flags that never take a value (and every --no-*), so the next word stays a positional ('test --json a.witness.json' runs that file)
const BOOL_FLAGS = new Set(["json", "build", "attach", "keys", "summary", "sheet", "annotate", "resize", "no-align", "wav", "no-input-events",
  "state", "shot", "no-shots", "no-audio", "no-pixels", "hold-camera", "y-up", "no-chart", "pixels", "no-images", "no-state",
  "safe-overlay", "no-auto-unlock", "auto-unlock", "all", "playtests", "replays", "shots", "movies", "force", "no-skill", "help",
  "hist", "no-map", "no-prune", "allow-calls", "dry-run", "live", "turns", "bug", "confusing", "idea", "wait",
  "picture", "dominant", "write", "clean", "lazy-draw"]);
// per command: the same name takes a value elsewhere (measure ui --fit contain; trace --watch "expr")
const CMD_BOOL = { shot: ["fit"], play: ["watch", "full"] };
// optional values: taken only when the next word looks like one (--repeat [N], --auto [N]; play note --fun "text" vs play end --fun 4)
const OPT_VALUE = { repeat: /^\d+$/, auto: /^\d+$/, fun: /^\d+(\.\d+)?$/,
  // --safe-insets [59,0,34,0 | iphone-portrait]: explicit insets (CSS px, top,right,bottom,left) or a preset name
  "safe-insets": /^(\d+(\.\d+)?)(,\d+(\.\d+)?){0,3}$|^(iphone|ipad)[a-z0-9-]*$/i };
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

// every flag some command reads or documents: anything else is a typo the command would silently ignore
// (tests/core/run.mjs checks that each opt.<name> in src/ and bin/ is listed)
export const KNOWN_FLAGS = new Set(["a", "against", "align", "all", "allow-calls", "alpha", "anim", "annotate", "at", "attach", "audio-tol", "auto", "auto-unlock", "b", "background", "base", "bg", "bins", "bug", "build", "camera", "capture", "cell", "clean", "clip", "clock", "closure", "cmd", "color", "colors", "cols", "compare", "config", "confusing", "crop", "cvd", "deaths", "depth", "device", "dh", "diff", "difficulty", "dominant", "dpi", "dry-run", "dw", "dx", "dy", "early", "edge", "effort", "engine", "env", "events", "every", "expect", "extra", "feedback", "fields", "fit", "follow", "for", "force", "fps", "from", "full", "fun", "game-hours", "goal", "goals", "help", "hist", "hold-camera", "horizon", "idea", "idle", "ignore", "input", "json", "k", "key", "keys", "kind", "lang", "layers", "lazy-draw", "list", "live", "loop", "mask", "max", "max-mb", "merge", "metric", "min", "min-contrast", "min-de", "min-share", "min-size", "min-tap", "min-text", "minutes", "model", "movies", "name", "near", "no-align", "no-audio", "no-auto-unlock", "no-chart", "no-images", "no-input-events", "no-map", "no-pixels", "no-prune", "no-shots", "no-skill", "no-state", "of", "out", "palette", "panel", "parallel", "params", "path", "paths", "pause-after", "persona", "picture", "pixels", "platform", "playtests", "policy", "port", "pos", "prefix", "project", "quiet", "realtime-wait", "rect", "ref", "region", "repeat", "replay", "replays", "resize", "s", "safe", "safe-insets", "safe-overlay", "save", "save-ref", "scale", "scale-rect", "scene", "scenes", "seed", "seeds", "session", "sh", "sheet", "shot", "shot-tol", "shots", "size", "smooth", "speed", "spike", "spike-ms", "standalone", "state", "step", "summary", "surfaces", "sw", "sx", "sy", "t", "threshold", "time", "timeout", "to", "tol", "tolerance", "track", "turns", "type", "types", "ui", "ui-scale", "until", "up", "version", "vs", "wait", "wall-minutes", "warmup", "watch", "wav", "when", "window", "within", "without", "witness", "write", "write-movie", "x", "xy", "y", "y-up", "zoom"]);
const dist = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
/** Flags in opt that no command knows, each with its closest known name (or null). */
export function unknownFlags(opt) {
  return Object.keys(opt).filter((k) => !KNOWN_FLAGS.has(k) && !k.startsWith("no-")).map((k) => {
    let best = null, bd = 3; for (const f of KNOWN_FLAGS) { const x = dist(k, f); if (x < bd) { bd = x; best = f; } }
    return { flag: k, suggest: best };
  });
}
