// Witness CLI: measure ui | colorblind | palette — readability checks on a screenshot (a PNG, or the game's frame).
//   ui          layout from the state.ui convention (clipped, off screen, safe area, overlaps, text size, text
//               contrast, almost-aligned edges), or text-like rows found from pixels when the game has no state.ui
//   colorblind  protan / deutan / tritan (/ achroma) simulation: simulated pictures, and which key colours (given,
//               the entities' sprite colours, or the picture's most common colours) stop being distinguishable
//   palette     colour count and palette compliance for pixel art: off-palette pixels, where, and their nearest colour
import fs from "node:fs";
import path from "node:path";
import { begin, stepTo } from "../core/runner.js";
import { parseRect } from "./see.js";
import { die, withGame, runOpts, media, printLogs, framesOf, shotImage, envelope, emit } from "./common.js";
import { entitiesOf, cameraHint } from "./measure.js";

const r2 = (v) => (v == null ? v : Math.round(v * 100) / 100);
const val = (v) => (v !== undefined && v !== true ? String(v) : null);
const readImage = (m, f) => { const p = path.resolve(String(f)); if (!fs.existsSync(p)) die(`no such image: ${f}`); return m.decodePNG(fs.readFileSync(p)); };
const rgb = (c) => `rgb(${c.join(",")})`;

export async function lookMeasure(what, files, opt) {
  const m = await media();
  const c = await import("../media/color.js");
  if (what === "ui") return uiMeasure(m, files, opt);
  if (what === "colorblind" || what === "cvd") return colorblindMeasure(m, c, files, opt);
  if (what === "palette") return paletteMeasure(m, c, files, opt);
}

/** The frame(s) to look at: a PNG file, or the game's screenshot (+ snapshot) at --at, once per --window size. */
async function getFrames(m, files, opt) {
  if (files[0]) return { frames: [{ img: readImage(m, files[0]), snap: null, label: path.basename(String(files[0])) }], file: path.resolve(String(files[0])) };
  const wins = val(opt.window) ? val(opt.window).split(",").map((w) => w.trim()).filter(Boolean) : [null];
  const frames = [];
  let root = null, cfg = null;
  await withGame(opt, async (s, cfg0, root0) => {
    cfg = cfg0; root = root0;
    if (!s.has("screenshot")) die("this game's adapter doesn't support 'screenshot'");
    const f = framesOf(val(opt.at) || "1", s.fps);
    for (const w of wins) {
      const st = await begin(s, runOpts(w ? { ...opt, window: w } : { ...opt, window: undefined }, cfg));
      await stepTo(s, st, f);
      const shot = await s.screenshot();
      const img = await shotImage(shot);
      const snap = await s.snapshot();
      frames.push({ img: { width: img.width, height: img.height, data: Uint8Array.from(img.data) }, snap, f, window: w, label: `f${f}${w ? ` at ${w}` : ""}` });
      printLogs(await s.drainLogs());
    }
  });
  return { frames, root, cfg };
}

/** Where pictures go: --out <dir>, else next to the input PNG, else the project's shots folder. */
function outDir(opt, got) {
  if (val(opt.out)) return path.resolve(val(opt.out));
  if (got.file) return path.dirname(got.file);
  return path.resolve(got.root, (got.cfg && got.cfg.shots) || "witness/shots");
}
const stemOf = (got, fallback) => (got.file ? path.basename(got.file).replace(/\.png$/i, "") : fallback);

/** "5%" -> fraction of the size; "12" or "12px" -> px. */
function pctOrPx(s, size, def) {
  const v = val(s) ?? def;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) die(`expected a percentage (5%) or pixels (12), got ${v}`);
  return /%$/.test(v) ? { px: (n / 100) * size, pct: n } : { px: n, pct: null };
}

// ------------------------------------------------------------------ measure ui

async function uiMeasure(m, files, opt) {
  const ui = await import("../media/ui.js");
  const got = await getFrames(m, files, opt);
  let uiFile = null;
  if (val(opt.ui)) {
    const p = path.resolve(val(opt.ui));
    if (!fs.existsSync(p)) die(`no such file: ${opt.ui}`);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    uiFile = Array.isArray(j) ? j : j.state?.ui ?? j.ui;
    if (!Array.isArray(uiFile)) die(`${opt.ui}: expected an array of UI elements, { ui: [...] } or a snapshot with state.ui`);
  }
  const alignTol = val(opt.align) != null ? +opt.align : 3;
  const results = [], written = [];
  for (const fr of got.frames) {
    const { img } = fr, W = img.width, H = img.height;
    const safe = pctOrPx(opt.safe, 1, "5%");
    const safeM = safe.pct != null ? safe.pct / 100 : { x: safe.px, y: safe.px };
    const minT = pctOrPx(opt["min-text"], H, "2%");
    const list = uiFile || (opt.pixels ? null : fr.snap?.state?.ui);
    let els, source;
    const panels = [];
    if (Array.isArray(list)) {
      try { els = ui.normalizeUI(list); } catch (e) { die(e.message); }
      source = uiFile ? path.basename(val(opt.ui)) : "state.ui";
    } else {
      const found = ui.findTextRows(img, { threshold: +(opt.threshold || 24) });
      els = found.rows.map((r) => ({ id: `text@${r.x},${r.y}`, kind: "text", x: r.x, y: r.y, w: r.w, h: r.h, text: null, fontPx: r2(r.glyphPx / 0.7), glyphPx: r.glyphPx, glyphs: r.glyphs, layer: 0 }));
      for (const p of found.panels) panels.push({ id: `panel@${p.x},${p.y}`, kind: "panel", ...p, text: null, fontPx: null, layer: 0 });
      els = els.concat(panels);
      source = "pixels";
    }
    // from pixels, glyph tops and side bearings vary: only the horizontal edges of text rows, 2 px or more apart
    const chk = ui.layoutChecks(els, { width: W, height: H, safe: safeM, minText: minT.px, alignTol, ...(source === "pixels" ? { alignEdges: ["left", "right", "centre-x"], alignMin: 2, alignKinds: ["text"] } : {}) });
    const minC = val(opt["min-contrast"]) != null ? +opt["min-contrast"] : null;
    const contrasts = [];
    const offIds = new Set(chk.offscreen.map((o) => o.id));
    const zero = els.filter((e) => !(e.w > 0 && e.h > 0) && (e.kind === "text" || e.text));
    for (const e of els) {
      if (offIds.has(e.id) || !(e.kind === "text" || e.text) || zero.includes(e)) continue;
      const tc = ui.textContrast(img, e);
      const need = minC ?? ((e.fontPx ?? e.h) >= 24 ? 3 : 4.5);
      contrasts.push({ id: e.id, need, ...(tc ? tc : { ratio: null }) });
    }
    // pixel mode: things touching the screen edge may be cut off
    const touching = source === "pixels" ? els.filter((e) => e.x <= 0 || e.y <= 0 || e.x + e.w >= W || e.y + e.h >= H).map((e) => e.id) : [];
    const byId = new Map(els.map((e) => [e.id, e]));
    const name = (id) => { const e = byId.get(id); return `${id} (${e.kind}${e.text ? ` "${e.text.length > 24 ? e.text.slice(0, 23) + "…" : e.text}"` : ""})`; };
    const F = [];
    const add = (level, kind, ids, text, extra = {}) => F.push({ level, kind, ids, text, ...extra });
    for (const c of chk.clipped) add("fail", "clipped", [c.id], `${name(c.id)} clipped: ${Object.entries(c.past).map(([k, v]) => `${v} px past the ${k} edge`).join(", ")} (${c.visiblePercent}% visible)`);
    for (const c of chk.offscreen) { const e = byId.get(c.id); add("fail", "offscreen", [c.id], `${name(c.id)} entirely off screen (rect ${e.x},${e.y} ${e.w}×${e.h}; screen ${W}×${H})`); }
    for (const id of touching) if (!chk.clipped.some((c) => c.id === id)) add("warn", "edge", [id], `${name(id)} touches the screen edge (cut off?)`);
    for (const o of chk.overlaps) add("fail", "overlap", [o.a, o.b], `${name(o.a)} and ${name(o.b)} overlap by ${o.rect[2]}×${o.rect[3]} px at ${o.rect[0]},${o.rect[1]}`);
    for (const e of zero) add("warn", "zero-size", [e.id], `${name(e.id)}: zero-size rect (${e.w}×${e.h}): nothing to measure`);
    for (const s of chk.small) { const e = byId.get(s.id); if (zero.includes(e)) continue; add("fail", "small", [s.id], source === "pixels" ? `${name(s.id)} glyphs ${e.glyphPx} px tall (≈ ${s.fontPx} px font) < ${r2(chk.minText)} px` : `${name(s.id)} ${s.estimated ? "rect height" : "font"} ${s.fontPx} px < ${r2(chk.minText)} px`); }
    for (const c of contrasts) {
      if (c.ratio == null) { const e = byId.get(c.id); if (e.text) add("warn", "invisible", [c.id], `${name(c.id)}: its rect is one flat colour (text not drawn?)`); continue; }
      const ol = c.outline ? ` (outlined in ${rgb(c.outline.color)}: text/outline ${c.outline.textVsOutline.toFixed(2)}, outline/background ${c.outline.outlineVsBg.toFixed(2)}, without the outline ${c.outline.plainRatio.toFixed(2)})` : "";
      if (c.ratio < c.need) add("fail", "contrast", [c.id], `${name(c.id)} contrast ${c.ratio.toFixed(2)}:1 < ${c.need} (text ${rgb(c.fg)} on ${rgb(c.bg)})${ol}`);
    }
    for (const u of chk.unsafe) if (!touching.includes(u.id)) add("warn", "safe", [u.id], `${name(u.id)} outside the safe area: ${Object.entries(u.into).map(([k, v]) => `${v} px into the ${k} margin`).join(", ")}`);
    for (const a of chk.aligned) add("warn", "align", [a.a, a.b], `${a.a} / ${a.b} almost aligned: ${a.edges.map((e) => `${e.edge} ${e.a} vs ${e.b}`).join(", ")} (${Math.max(...a.edges.map((e) => e.diff))} px off)`);
    const fails = F.filter((f) => f.level === "fail").length, warns = F.length - fails;
    const readable = contrasts.filter((c) => c.ratio != null && c.ratio >= c.need && !chk.small.some((s) => s.id === c.id));
    // the annotated picture
    if (val(opt.out) || opt.picture) {
      const bad = new Set(F.filter((f) => f.level === "fail").flatMap((f) => f.ids)), warn = new Set(F.filter((f) => f.level === "warn").flatMap((f) => f.ids));
      const items = els.filter((e) => e.w > 0 && e.h > 0).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h, label: e.id, color: bad.has(e.id) ? "#ff4d5e" : warn.has(e.id) ? "#ffd166" : "#3ddc97" }));
      const mx = chk.margins.x, my = chk.margins.y;
      items.push({ x: mx, y: my, w: W - 2 * mx, h: H - 2 * my, color: "#8ecae6" });
      const png = m.annotate(img, items, { title: `ui ${fr.label}: red problem · yellow warning · green fine · blue safe area` });
      const dir = outDir(opt, got);
      const file = val(opt.out) && /\.png$/i.test(val(opt.out)) ? path.resolve(val(opt.out).replace(/\.png$/i, got.frames.length > 1 && fr.window ? `-${fr.window}.png` : ".png")) : path.join(dir, `${stemOf(got, "ui")}-ui${fr.window ? `-${fr.window}` : ""}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, png);
      written.push(file);
    }
    results.push({ fr, W, H, source, els, chk, contrasts, F, fails, warns, readable, minT, safe });
  }
  // text
  const lines = [];
  for (const r of results) {
    const heur = r.source === "pixels";
    lines.push(`measure ui ${r.fr.label} (${r.W}×${r.H}): ${heur ? `no state.ui — ${r.els.filter((e) => e.kind === "text").length} text-like rows and ${r.els.filter((e) => e.kind === "panel").length} panels found from pixels (a heuristic: expose state.ui for exact checks)` : `${r.els.length} elements from ${r.source}`}`);
    lines.push(`  safe area ${r.safe.pct != null ? `${r.safe.pct}% = ` : ""}${r.chk.margins.x}×${r.chk.margins.y} px margins · min text ${r2(r.chk.minText)} px${r.minT.pct != null ? ` (${r.minT.pct}% of ${r.H})` : ""}${heur ? " (glyph height ≈ 0.7 × font px)" : ""} · text contrast ≥ ${val(opt["min-contrast"]) ?? "4.5 (3 for 24 px+)"} · edges within ${alignTol} px`);
    lines.push(r.F.length ? `  ${r.fails ? "✖" : "⚠"} ${r.fails} problem${r.fails === 1 ? "" : "s"}, ${r.warns} warning${r.warns === 1 ? "" : "s"}` : r.els.length ? `  ✔ no layout problems` : "  nothing to check: no UI elements found");
    for (const f of r.F) lines.push(`  ${f.level === "fail" ? "✖" : "⚠"} ${f.text}`);
    if (r.readable.length) lines.push(`  ✔ readable: ${r.readable.slice(0, 8).map((c) => { const e = r.els.find((x) => x.id === c.id); return `${c.id} ${e.glyphPx != null ? `glyphs ${e.glyphPx}` : e.fontPx ?? e.h} px ${c.ratio.toFixed(1)}:1${c.outline ? ` (outline; ${c.outline.plainRatio.toFixed(1)}:1 without)` : ""}`; }).join(" · ")}${r.readable.length > 8 ? ` (+${r.readable.length - 8})` : ""}`);
  }
  if (results.length > 1) {
    // the same finding at two sizes: the same kind on the same elements
    const key = (f) => `${f.kind}:${f.ids.join("+")}`;
    const all = results.map((r) => new Map(r.F.filter((f) => f.level === "fail").map((f) => [key(f), f.text])));
    const common = [...all[0].keys()].filter((k) => all.every((s) => s.has(k)));
    lines.push(`windows: ${results.map((r) => `${r.fr.window || "default"} ${r.fails} problems`).join(" · ")}${common.length ? ` (${common.length} at every size)` : ""}`);
    results.forEach((r, i) => { const only = [...all[i]].filter(([k]) => !common.includes(k)).map(([, t]) => t); if (only.length) lines.push(`  only at ${r.fr.window || "default"}: ${only.join(" · ")}`); });
  }
  if (written.length) lines.push(`picture: ${written.join(", ")} (open it: boxes by status, the safe area in blue)`);
  const first = results[0];
  const count = (r, k) => r.F.filter((f) => f.kind === k).length;
  const sumOf = (r) => ({ elements: r.els.length, source: r.source, problems: r.fails, warnings: r.warns, clipped: count(r, "clipped"), offscreen: count(r, "offscreen"), overlaps: count(r, "overlap"), smallText: count(r, "small"), lowContrast: count(r, "contrast"), unsafe: count(r, "safe"), misaligned: count(r, "align"), touchingEdge: count(r, "edge") });
  const dataOf = (r) => ({
    frame: r.fr.f ?? null, window: r.fr.window ?? null, width: r.W, height: r.H, source: r.source, margins: r.chk.margins, minText: r.chk.minText,
    elements: r.els.map((e) => ({ id: e.id, kind: e.kind, rect: [e.x, e.y, e.w, e.h], text: e.text, fontPx: e.fontPx, ...(e.glyphPx != null ? { glyphPx: e.glyphPx, glyphs: e.glyphs } : {}) })),
    findings: r.F, contrast: r.contrasts, checks: { clipped: r.chk.clipped, offscreen: r.chk.offscreen, unsafe: r.chk.unsafe, overlaps: r.chk.overlaps, small: r.chk.small, aligned: r.chk.aligned },
  });
  const totalFails = results.reduce((s, r) => s + r.fails, 0);
  const env = envelope("measure ui", {
    ok: totalFails === 0,
    verdict: results.length > 1 ? `${totalFails} UI problems over ${results.length} window sizes` : first.F.length ? `${first.fails} UI problems, ${first.warns} warnings${first.source === "pixels" ? " (pixel heuristic)" : ""}` : !first.els.length ? "no UI elements found" : `UI layout clean (${first.els.length} elements${first.source === "pixels" ? ", pixel heuristic" : ""})`,
    summary: results.length > 1 ? { problems: totalFails, warnings: results.reduce((s, r) => s + r.warns, 0), source: first.source, windows: results.map((r) => ({ window: r.fr.window, ...sumOf(r) })) } : sumOf(first),
    data: results.length > 1 ? { windows: results.map(dataOf) } : dataOf(first),
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ measure colorblind

function parseColors(c, s) {
  return String(s).split(",").map((t) => t.trim()).filter(Boolean).map((t, i) => {
    const eq = t.indexOf("=");
    const nm = eq > 0 ? t.slice(0, eq).trim() : null, col = eq > 0 ? t.slice(eq + 1).trim() : t;
    let v;
    try { v = c.parsePalette(col)[0]; } catch { die(`--colors: "${t}" is not name=#rrggbb or #rrggbb`); }
    return { name: nm || c.hex(v), color: v };
  });
}

/** Each entity type's main sprite colour: the sprites matched to state positions, their most common colour. */
function entityColors(m, c, img, snap, types, opt) {
  const ents = entitiesOf(snap, types);
  if (!ents.length) return { reason: "no entities with a position in state.entities" };
  const blobs = m.findBlobs(img, { threshold: +(opt.threshold || 24) });
  const fit = m.fitProjection(ents, blobs, { hint: cameraHint(snap) });
  if (!fit.ok) return { reason: `state → screen didn't fit (${fit.reason})` };
  const pal = c.dominantColors(img, { max: 4, minShare: 0.05 }).map((d) => d.color);
  const bg = pal[0];
  const per = new Map();
  const d = img.data, W = img.width;
  for (const q of fit.all) {
    const b = q.blob.bbox, t = q.entity.type;
    const acc = per.get(t) || { buckets: new Map(), n: 0 };
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const o = (y * W + x) * 4;
      if (pal.some((p) => Math.abs(d[o] - p[0]) <= 24 && Math.abs(d[o + 1] - p[1]) <= 24 && Math.abs(d[o + 2] - p[2]) <= 24)) continue;
      const k = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
      const e = acc.buckets.get(k) || [0, 0, 0, 0];
      e[0] += d[o]; e[1] += d[o + 1]; e[2] += d[o + 2]; e[3]++;
      acc.buckets.set(k, e);
    }
    acc.n++;
    per.set(t, acc);
  }
  const colors = [];
  for (const [t, acc] of per) {
    const top = [...acc.buckets.values()].sort((a, b) => b[3] - a[3])[0];
    if (top) colors.push({ name: t, color: [top[0], top[1], top[2]].map((v) => Math.round(v / top[3])), sprites: acc.n });
  }
  if (bg) colors.push({ name: "background", color: bg });
  return { colors, matched: fit.matched, total: fit.total };
}

async function colorblindMeasure(m, c, files, opt) {
  const tsel = val(opt.type) || "all";
  const types = tsel === "all" ? ["protan", "deutan", "tritan"] : tsel.split(",").map((t) => t.trim());
  for (const t of types) if (!c.CVD_TYPES.includes(t)) die(`--type is protan, deutan, tritan, achroma or all (got ${t})`);
  const minDE = val(opt["min-de"]) != null ? +opt["min-de"] : 20;
  const got = await getFrames(m, files, opt);
  const fr = got.frames[0], img = fr.img;
  let colors, source, note = "";
  if (val(opt.colors)) { colors = parseColors(c, opt.colors); source = "given"; }
  else if (fr.snap && !opt.dominant) {
    const ec = entityColors(m, c, img, fr.snap, val(opt.types) ? val(opt.types).split(",").map((t) => t.trim()) : null, opt);
    if (ec.colors && ec.colors.length >= 2) { colors = ec.colors; source = "entities"; note = `sprite colours of ${ec.colors.length - 1} entity types (${ec.matched} of ${ec.total} entities found on screen) + the background`; }
    else note = `${ec.reason || "fewer than 2 entity colours"}: using the picture's most common colours`;
  }
  if (!colors) {
    colors = c.dominantColors(img, { max: +(opt.max || 8), minShare: 0.002 }).map((d) => ({ name: d.hex, color: d.color, share: d.share }));
    source = "dominant";
    note = note || `the ${colors.length} most common colours (each ≥ 0.2% of the picture)`;
  }
  if (colors.length < 2 && !(opt.a && opt.b)) die("need at least 2 colours to compare (--colors name=#hex,name=#hex)");
  const pairs = colors.length >= 2 ? c.pairsUnderCVD(colors, { types, minDE }) : [];
  // masks: the contrast of two pixel sets under each type
  let maskRes = null;
  const sims = Object.fromEntries(types.map((t) => [t, c.simulateCVD(img, t)]));
  if (opt.a && opt.b) {
    const mask = (spec) => {
      const s = String(spec);
      if (s.startsWith("#") || s.startsWith("rgb")) { const [col, tol] = s.split("~"); return m.maskFromColor(img, col, +(tol || 0)); }
      if (s.startsWith("diff:")) { const p = path.resolve(s.slice(5)); if (!fs.existsSync(p)) die(`no such image: ${s.slice(5)}`); return m.maskDiff(img, fs.readFileSync(p), { threshold: +(opt.threshold || 16) }).mask; }
      return m.maskFromRect(img.width, img.height, parseRect(s));
    };
    const A = mask(opt.a);
    const B = /^ring(:\d+)?$/.test(String(opt.b)) ? m.ringMask(A, img.width, img.height, +(String(opt.b).split(":")[1] || 2)) : mask(opt.b);
    maskRes = { normal: m.contrast(img, A, B) };
    for (const t of types) maskRes[t] = m.contrast(sims[t], A, B);
  }
  // pictures
  const written = [];
  if (!opt["no-images"]) {
    const dir = outDir(opt, got), stem = stemOf(got, "colorblind");
    fs.mkdirSync(dir, { recursive: true });
    for (const t of types) { const f = path.join(dir, `${stem}-${t}.png`); fs.writeFileSync(f, m.encodePNG(img.width, img.height, sims[t].data)); written.push(f); }
    const cells = [{ img, label: "normal vision" }, ...types.map((t) => ({ img: sims[t], label: c.TYPE_NAMES[t] }))];
    const sheet = m.contactSheet(cells, { cols: cells.length === 4 ? 2 : Math.min(cells.length, 3), title: `colour-vision simulation (Machado 2009): ${fr.label}`, subtitle: "the same frame as seen with each deficiency" });
    const f = path.join(dir, `${stem}-cvd.png`);
    fs.writeFileSync(f, sheet.png);
    written.unshift(f);
  }
  // text
  const lines = [`measure colorblind ${fr.label} (${img.width}×${img.height}): ${note || `${colors.length} given colours`} · confusable below ΔE ${minDE}`];
  if (colors.length) lines.push(`  colours: ${colors.map((k) => `${k.name}${k.name.startsWith("#") ? "" : ` ${c.hex(k.color)}`}${k.share != null ? ` ${r2(k.share * 100)}%` : ""}`).join(" · ")}`);
  const fmtPair = (p, t) => `${p.a} vs ${p.b} ΔE ${p.normal.deltaE} → ${p.types[t].deltaE}`;
  if (pairs.length) {
    const nAlready = pairs.filter((p) => p.normal.deltaE < minDE);
    const minN = pairs.reduce((a, p) => (p.normal.deltaE < a.normal.deltaE ? p : a));
    lines.push(`  normal: ${nAlready.length ? `⚠ ${nAlready.length} pair${nAlready.length > 1 ? "s" : ""} already close (${nAlready.slice(0, 3).map((p) => `${p.a} vs ${p.b} ΔE ${p.normal.deltaE}`).join(", ")})` : (pairs.length === 1 ? "distinct" : `all ${pairs.length} pairs distinct`)} · closest ${minN.a} vs ${minN.b} ΔE ${minN.normal.deltaE}`);
    for (const t of types) {
      const lost = pairs.filter((p) => p.lost.includes(t)).sort((a, b) => a.types[t].deltaE - b.types[t].deltaE);
      const closest = pairs.reduce((a, p) => (p.types[t].deltaE < a.types[t].deltaE ? p : a));
      lines.push(lost.length ? `  ✖ ${t}: ${lost.length} pair${lost.length > 1 ? "s" : ""} ${lost.length > 1 ? "become" : "becomes"} confusable: ${lost.slice(0, 6).map((p) => fmtPair(p, t)).join(" · ")}` : `  ✔ ${t}: still distinct · closest ${fmtPair(closest, t)}`);
    }
  }
  if (maskRes) lines.push(`  --a vs --b: ${["normal", ...types].map((t) => `${t} ${maskRes[t].ratio.toFixed(2)}:1 ΔE ${maskRes[t].deltaE.toFixed(1)}${t !== "normal" && maskRes.normal.deltaE >= minDE && maskRes[t].deltaE < minDE ? " ✖" : ""}`).join(" · ")}`);
  if (written.length) lines.push(`  pictures: ${written[0]} (normal + each type side by side: open it and look)${written.length > 1 ? `; one per type: ${written.slice(1).map((f) => path.basename(f)).join(", ")}` : ""}`);
  const lostBy = Object.fromEntries(types.map((t) => [t, pairs.filter((p) => p.lost.includes(t)).length]));
  const minBy = Object.fromEntries(types.map((t) => [t, pairs.length ? Math.min(...pairs.map((p) => p.types[t].deltaE)) : null]));
  const lostTotal = pairs.filter((p) => p.lost.length).length + (maskRes ? types.filter((t) => maskRes.normal.deltaE >= minDE && maskRes[t].deltaE < minDE).length : 0);
  const env = envelope("measure colorblind", {
    ok: lostTotal === 0,
    verdict: lostTotal ? `${Object.entries(lostBy).filter(([, n]) => n).map(([t, n]) => `${n} pair${n > 1 ? "s" : ""} confusable under ${t}`).join(", ") || "the --a/--b pair becomes confusable"}` : `key colours stay distinct under ${types.join(", ")}`,
    summary: { colors: colors.length, source, pairs: pairs.length, minDE, lost: lostBy, lostPairs: pairs.filter((p) => p.lost.length).length, minDeltaE: { normal: pairs.length ? Math.min(...pairs.map((p) => p.normal.deltaE)) : null, ...minBy }, ...(maskRes ? { maskDeltaE: Object.fromEntries(Object.entries(maskRes).map(([t, r]) => [t, r.deltaE])) } : {}) },
    data: { types, colors: colors.map((k) => ({ name: k.name, hex: c.hex(k.color), ...(k.share != null ? { share: k.share } : {}), ...(k.sprites ? { sprites: k.sprites } : {}) })), pairs, masks: maskRes },
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}

// ------------------------------------------------------------------ measure palette

async function paletteMeasure(m, c, files, opt) {
  const got = await getFrames(m, files, opt);
  const fr = got.frames[0], img = fr.img;
  const region = val(opt.region) ? parseRect(val(opt.region)) : null;
  const max = val(opt.max) != null ? +opt.max : null;
  const list = val(opt.list) != null ? +opt.list : 20;
  let palette = null, palName = null;
  if (val(opt.palette)) {
    const spec = val(opt.palette), p = path.resolve(spec);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        palName = path.basename(p);
        palette = /\.png$/i.test(p) ? c.paletteOfImage(m.decodePNG(fs.readFileSync(p))) : c.parsePalette(fs.readFileSync(p, "utf8"), path.extname(p).slice(1).toLowerCase());
      } else { palette = c.parsePalette(spec); palName = "given"; }
    } catch (e) { die(`--palette ${spec}: ${e.message}`); }
    if (palette.length > 4096) die(`--palette has ${palette.length} colours: is that a palette?`);
  }
  const budget = c.colorBudget(img, max, { region });
  const lines = [`measure palette ${fr.label} (${img.width}×${img.height}${region ? `, region ${region.x},${region.y} ${region.w}×${region.h}` : ""}): ${budget.colors} distinct colours in ${budget.pixels} px`];
  lines.push(`  most used: ${budget.top.slice(0, 8).map((t) => `${t.hex} ${r2(t.share * 100)}%`).join(" · ")}`);
  if (budget.rare.colors) lines.push(`  ${budget.rare.colors} colours under 0.1% each (${budget.rare.pixels} px): ${budget.rare.colors > 16 ? "blending, anti-aliasing or scaling blur? (pixel art usually has none)" : "rare details or stray pixels"}`);
  let pc = null;
  const written = [];
  if (palette) {
    pc = c.paletteCheck(img, palette, { tolerance: +(opt.tolerance || 0), region, list });
    if (!pc.offPixels) lines.push(`  ✔ every pixel is on the ${palette.length}-colour palette (${palName})${pc.unused.length ? ` · unused: ${pc.unused.slice(0, 12).join(" ")}${pc.unused.length > 12 ? ` (+${pc.unused.length - 12})` : ""}` : ""}`);
    else {
      lines.push(`  ✖ ${pc.offPixels} px off the ${palette.length}-colour palette (${pc.offPercent}%), ${pc.offColors.length} colour${pc.offColors.length > 1 ? "s" : ""}, within x=${pc.bbox.x} y=${pc.bbox.y} ${pc.bbox.w}×${pc.bbox.h}`);
      for (const o of pc.offColors.slice(0, 10)) lines.push(`    ${o.hex} ×${o.count} first at ${o.first.join(",")}, box x=${o.bbox.x} y=${o.bbox.y} ${o.bbox.w}×${o.bbox.h} → nearest ${o.nearest} (ΔE ${o.deltaE})`);
      if (pc.offColors.length > 10) lines.push(`    … ${pc.offColors.length - 10} more colours`);
      lines.push(`    first ${pc.sample.length} px: ${pc.sample.map((p) => p.join(",")).join(" ")}`);
      if (val(opt.out)) {
        const file = /\.png$/i.test(val(opt.out)) ? path.resolve(val(opt.out)) : path.join(path.resolve(val(opt.out)), `${stemOf(got, "palette")}-offpalette.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const im = c.offPaletteImage(img, pc.mask);
        fs.writeFileSync(file, m.encodePNG(im.width, im.height, im.data));
        written.push(file);
        lines.push(`    picture: ${file} (off-palette pixels in magenta)`);
      } else lines.push("    (--out off.png draws them in magenta)");
      if (pc.unused.length) lines.push(`  unused palette colours: ${pc.unused.slice(0, 12).join(" ")}${pc.unused.length > 12 ? ` (+${pc.unused.length - 12})` : ""}`);
    }
  }
  if (max != null) {
    if (!budget.over) lines.push(`  ✔ ${budget.colors} colours ≤ max ${max}`);
    else {
      lines.push(`  ✖ ${budget.colors} colours > max ${max} (${budget.colors - max} too many); least used:`);
      for (const l of budget.leastUsed) lines.push(`    ${l.hex} ×${l.count} first at ${l.first.join(",")}${l.nearest ? ` → closest ${l.nearest} (ΔE ${l.deltaE})` : ""}`);
    }
  }
  const ok = !(pc && pc.offPixels) && !budget.over;
  const env = envelope("measure palette", {
    ok,
    verdict: pc ? (pc.offPixels ? `${pc.offPixels} px off the palette (${pc.offColors.length} colours)` : "every pixel on the palette") + (budget.over ? `, ${budget.colors} colours > max ${max}` : "") : max != null ? (budget.over ? `${budget.colors} colours > max ${max}` : `${budget.colors} colours ≤ max ${max}`) : `${budget.colors} colours`,
    summary: { colors: budget.colors, pixels: budget.pixels, rareColors: budget.rare.colors, ...(max != null ? { max, over: budget.over } : {}), ...(pc ? { paletteSize: palette.length, offPixels: pc.offPixels, offPercent: pc.offPercent, offColors: pc.offColors.length, unused: pc.unused.length } : {}) },
    data: { top: budget.top, rare: budget.rare, leastUsed: budget.leastUsed, ...(pc ? { offColors: pc.offColors.map(({ color, ...o }) => o), sample: pc.sample, bbox: pc.bbox, unused: pc.unused } : {}) },
    files: written,
  });
  return emit(env, lines.join("\n"), opt);
}
