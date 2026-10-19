// Colour tests: `node tests/media/color.mjs` — colour-vision simulation, key colours and palette compliance, on
// synthesized pictures whose right answers are known by construction.
import {
  CVD_TYPES, cvdMatrix, simulateColor, simulateCVD, deltaE, contrastRatio, hex, dominantColors, pairsUnderCVD,
  parsePalette, paletteOfImage, paletteCheck, colorBudget, offPaletteImage, figureGround, clusterColors,
} from "../../src/media/color.js";
import { ok, show, done } from "./harness.mjs";

console.log("color");

const img = (w, h, c) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { d.set([c[0], c[1], c[2], 255], i * 4); } return { width: w, height: h, data: d }; };
const put = (im, x, y, c) => im.data.set([c[0], c[1], c[2], 255], (y * im.width + x) * 4);
const rect = (im, x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(im, i, j, c); };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- simulation: Machado 2009 severity 1.0 in linear RGB (reference values computed independently)
{
  for (const t of ["protan", "deutan", "tritan"]) ok(`${t}: rows sum to 1`, cvdMatrix(t).every((r) => Math.abs(r[0] + r[1] + r[2] - 1) < 1e-5));
  ok("greys, black and white are unchanged under every type", CVD_TYPES.every((t) => [[128, 128, 128], [0, 0, 0], [255, 255, 255], [37, 37, 37]].every((g) => same(simulateColor(g, t), g))));
  const ref = {
    protan: [[[255, 0, 0], [109, 95, 0]], [[0, 255, 0], [255, 229, 0]], [[0, 0, 255], [0, 89, 255]]],
    deutan: [[[255, 0, 0], [163, 144, 0]], [[0, 255, 0], [239, 214, 58]], [[0, 0, 255], [0, 61, 251]]],
    tritan: [[[255, 0, 0], [255, 0, 15]], [[0, 255, 0], [0, 247, 217]], [[0, 0, 255], [0, 107, 150]]],
  };
  for (const [t, rows] of Object.entries(ref)) for (const [c, want] of rows) ok(`${t} ${hex(c)} → ${hex(want)}`, same(simulateColor(c, t), want), simulateColor(c, t));
  ok("achroma: every channel the WCAG luminance (pure red → 127)", same(simulateColor([255, 0, 0], "achroma"), [127, 127, 127]), simulateColor([255, 0, 0], "achroma"));
  ok("unknown type: a clear error", (() => { try { simulateColor([1, 2, 3], "blue"); return false; } catch (e) { return /protan, deutan, tritan, achroma/.test(e.message); } })());
  const im = img(4, 2, [220, 50, 50]); put(im, 1, 1, [60, 180, 75]); im.data[3] = 7;
  const s = simulateCVD(im, "deutan");
  ok("simulateCVD: each pixel is simulateColor of it, alpha kept", same([...s.data.slice(0, 4)], [...simulateColor([220, 50, 50], "deutan"), 7]) && same([...s.data.slice(20, 23)], simulateColor([60, 180, 75], "deutan")) && s.data[7] === 255);
}

// ---- pairs: red/green lost under deutan, a tritan-only pair, ΔE and contrast
{
  const p = pairsUnderCVD([{ name: "hostile", color: [220, 50, 50] }, { name: "friendly", color: [60, 180, 75] }], { minDE: 20 })[0];
  show("hostile vs friendly ΔE normal → p/d/t", `${p.normal.deltaE} → ${p.types.protan.deltaE} / ${p.types.deutan.deltaE} / ${p.types.tritan.deltaE}`);
  ok("red vs green: distinct normally, confusable under deutan only", p.normal.deltaE > 100 && p.types.deutan.deltaE < 20 && same(p.lost, ["deutan"]), p);
  ok("pair ΔE is CIE76 of the simulated colours", Math.abs(p.types.deutan.deltaE - deltaE(simulateColor([220, 50, 50], "deutan"), simulateColor([60, 180, 75], "deutan"))) < 0.006);
  const t = pairsUnderCVD([{ name: "sky", color: [100, 200, 255] }, { name: "mint", color: [150, 230, 150] }], { minDE: 20 })[0];
  ok("sky blue vs mint: lost under tritan only", same(t.lost, ["tritan"]) && t.types.protan.deltaE > 60, t);
  ok("a pair already close normally is never 'lost'", pairsUnderCVD([{ name: "a", color: [100, 100, 100] }, { name: "b", color: [104, 100, 100] }])[0].lost.length === 0);
  ok("contrastRatio: white on black 21, same colour 1", Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - 21) < 1e-9 && contrastRatio([9, 9, 9], [9, 9, 9]) === 1);
}

// ---- dominant colours: exact shares by construction
{
  const im = img(100, 100, [20, 24, 40]);   // 6000 px
  rect(im, 0, 0, 30, 100, [255, 210, 60]);   // 3000 px
  rect(im, 30, 0, 10, 100, [80, 200, 255]);  // 1000 px
  put(im, 99, 99, [255, 0, 255]);              // 1 px: under the share floor
  const d = dominantColors(im);
  ok("dominant: three colours, most common first, exact colours and shares", d.length === 3 && d[0].hex === "#141828" && d[0].count === 5999 && d[1].hex === "#ffd23c" && d[1].share === 0.3 && d[2].hex === "#50c8ff" && d[2].count === 1000, d);
  const g = img(10, 10, [100, 100, 100]); rect(g, 0, 0, 5, 10, [101, 100, 100]);
  ok("dominant: near-identical buckets merge (ΔE < 6)", dominantColors(g).length === 1 && dominantColors(g)[0].count === 100);
}

// ---- palettes: parsing, compliance (3 planted off pixels), tolerance, budget
{
  ok("parse inline", same(parsePalette("#000, #fff,#ff0000").map(hex), ["#000000", "#ffffff", "#ff0000"]));
  ok("parse Lospec .hex lines (no #), duplicates dropped", same(parsePalette("1a1c2c\n5d275d\r\n1A1C2C\n").map(hex), ["#1a1c2c", "#5d275d"]));
  ok("parse GIMP .gpl", same(parsePalette("GIMP Palette\nName: x\n#\n 26  28  44\tdark\n255 255 255 white\n").map(hex), ["#1a1c2c", "#ffffff"]));
  ok("parse JSON", same(parsePalette('{"colors": ["#123456", "abcdef"]}').map(hex), ["#123456", "#abcdef"]) && same(parsePalette('["#010203"]').map(hex), ["#010203"]));
  ok("parse: a bad token is named", (() => { try { parsePalette("#123, nope"); return false; } catch (e) { return /"nope"/.test(e.message); } })());
  const pal = [[20, 24, 40], [255, 210, 60], [80, 200, 255], [255, 255, 255]];
  const im = img(64, 32, pal[0]);
  rect(im, 10, 10, 8, 8, pal[1]); rect(im, 30, 4, 6, 6, pal[2]);
  put(im, 40, 20, [255, 0, 255]); put(im, 5, 25, [255, 0, 255]); put(im, 12, 11, [250, 205, 55]);   // 3 off pixels
  const r = paletteCheck(im, pal);
  show("off-palette", `${r.offPixels} px, ${r.offColors.map((o) => `${o.hex}×${o.count}→${o.nearest}`).join(" ")}`);
  ok("palette: exactly 3 off pixels in 2 colours, most common first", r.offPixels === 3 && r.offColors.length === 2 && r.offColors[0].hex === "#ff00ff" && r.offColors[0].count === 2 && r.offColors[1].count === 1, r.offColors);
  ok("palette: coordinates (row-major), boxes and the overall box", same(r.sample.map(String), ["12,11", "40,20", "5,25"]) && r.offColors[0].bbox.x === 5 && r.offColors[0].bbox.w === 36 && r.offColors[0].bbox.h === 6 && r.bbox.x === 5 && r.bbox.y === 11 && r.bbox.w === 36 && r.bbox.h === 15, [r.sample, r.bbox]);
  ok("palette: nearest colour and its ΔE", r.offColors[1].nearest === "#ffd23c" && Math.abs(r.offColors[1].deltaE - deltaE([250, 205, 55], [255, 210, 60])) < 0.006);
  ok("palette: unused colours and percent", same(r.unused, ["#ffffff"]) && r.offPercent === Math.round((300 / 2048) * 10000) / 10000 && r.colors === 5, [r.unused, r.offPercent]);
  ok("palette: the mask marks exactly the off pixels", r.mask.reduce((s, v) => s + v, 0) === 3 && r.mask[20 * 64 + 40] === 1);
  ok("palette: tolerance 5 accepts the near-miss pixel", paletteCheck(im, pal, { tolerance: 5 }).offPixels === 2);
  ok("palette: a region limits the check", paletteCheck(im, pal, { region: { x: 0, y: 0, w: 20, h: 20 } }).offPixels === 1);
  const strip = img(4, 1, [0, 0, 0]); pal.forEach((c, i) => put(strip, i, 0, c));
  ok("paletteOfImage: a strip's colours in order", same(paletteOfImage(strip).map(hex), pal.map(hex)));
  const o = offPaletteImage(im, r.mask);
  ok("offPaletteImage: magenta where off, dim grey elsewhere", same([...o.data.slice((20 * 64 + 40) * 4, (20 * 64 + 40) * 4 + 3)], [255, 0, 255]) && o.data[0] === o.data[1] && o.data[0] < 40);
  const b = colorBudget(im, 3);
  ok("budget: 5 colours > max 3, least used first with a merge target", b.colors === 5 && b.over && b.leastUsed.length === 2 && b.leastUsed[0].count === 1 && b.leastUsed[0].nearest === "#ffd23c" && b.leastUsed[1].hex === "#ff00ff", b.leastUsed);
  ok("budget: within max", !colorBudget(im, 5).over && colorBudget(im, 5).leastUsed.length === 0);
  ok("budget: colours under 0.1% are counted as rare", b.rare.colors === 2 && b.rare.pixels === 3, b.rare);
}

// ---- regressions: Paint.NET palettes, merge targets that stay, dominant colours in order after merging
{
  const pdn = parsePalette("; paint.net Palette File\n; Downloaded from Lospec.com\nFFFF0000\nFF00FF00\nFF0000FF", "txt");
  ok("parsePalette: Lospec PAINT.NET TXT (comment lines, AARRGGBB) → red, green, blue", pdn.map(hex).join() === "#ff0000,#00ff00,#0000ff", pdn);
  ok("parsePalette: a paint.net header makes 8 digits AARRGGBB in any file; elsewhere RRGGBBAA", parsePalette("; paint.net\n80112233").map(hex).join() === "#112233" && parsePalette("112233ff").map(hex).join() === "#112233");
  const im = img(4, 3, [255, 255, 255]);
  put(im, 1, 2, [1, 2, 3]); put(im, 2, 2, [1, 2, 3]); put(im, 3, 2, [9, 9, 9]);
  const b = colorBudget(im, 1);
  ok("colorBudget: merge targets are colours that stay (not each other)", b.leastUsed.length === 2 && b.leastUsed.every((e) => e.nearest === "#ffffff"), b.leastUsed);
  const W = 100, H = 100, big = img(W, H, [0, 0, 0]);
  for (let i = 0; i < W * H; i++) { const k = i % 8; const c = i < 3000 ? [200, 30, 30] : i < 5500 ? [30, 30, 200] : [46 + (k & 1) * 4, 206 + ((k >> 1) & 1) * 4, 30 + ((k >> 2) & 1) * 4]; put(big, i % W, Math.floor(i / W), c); }
  const dc = dominantColors(big, { max: 2 });
  ok("dominantColors: re-sorted after merging, so a colour that grew by merging (45%) isn't cut by max", dc.map((x) => `${x.hex} ${x.share}`).join() === "#30d020 0.45,#c81e1e 0.3", dc);
}

// ---- figure vs ground: a disc on four solid quadrants; every edge pair is (figure, that ground): exact ratios
{
  const F = [80, 200, 255], G = { sand: [194, 178, 128], snow: [240, 244, 250], grass: [60, 140, 60], road: [70, 70, 75] };
  const im = img(64, 64, [0, 0, 0]);
  rect(im, 0, 0, 32, 32, G.sand); rect(im, 32, 0, 32, 32, G.snow); rect(im, 0, 32, 32, 32, G.grass); rect(im, 32, 32, 32, 32, G.road);
  const mask = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const dx = x + 0.5 - 32, dy = y + 0.5 - 32; if (dx * dx + dy * dy <= 49) { mask[y * 64 + x] = 1; put(im, x, y, F); } }
  const r = figureGround(im, mask, { min: 3 });
  show("figure surfaces", r.surfaces.map((s) => `${s.hex} ${s.share} ${s.ratio.worst}/${s.ratio.median}`).join(" · "));
  ok("figure: 4 surfaces, one per quadrant, a quarter of the ring each", r.surfaces.length === 4 && r.surfaces.every((s) => s.share === 0.25 && !s.minor), r.surfaces);
  for (const [name, g] of Object.entries(G)) {
    const s = r.surfaces.find((x) => x.hex === hex(g)), want = Math.round(contrastRatio(F, g) * 100) / 100, wantE = Math.round(deltaE(F, g) * 100) / 100;
    ok(`figure vs ${name}: worst = median = ${want}:1, ΔE ${wantE}`, s && s.ratio.worst === want && s.ratio.median === want && s.deltaE.worst === wantE && s.worstFigure === hex(F), s);
  }
  const snow = r.surfaces.find((x) => x.hex === hex(G.snow));
  ok("figure: the share of the edge under min 3 (snow 1.72:1 → 100%, road 4.94 → 0%); overall worst = sand 1.11", snow.under === 100 && r.surfaces.find((x) => x.hex === hex(G.road)).under === 0 && r.all.ratio.worst === 1.11 && r.all.worstGround === hex(G.sand));
  // a 1 px dark outline equal to the road colour: against the road the edge vanishes (1:1), elsewhere it's the outline's
  const sq = img(48, 48, G.sand); rect(sq, 24, 0, 24, 48, G.road);
  const m2 = new Uint8Array(48 * 48);
  rect(sq, 16, 16, 16, 16, G.road); rect(sq, 17, 17, 14, 14, F);
  for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) m2[y * 48 + x] = 1;
  const r2 = figureGround(sq, m2, {});
  const road = r2.surfaces.find((x) => x.hex === hex(G.road)), sand = r2.surfaces.find((x) => x.hex === hex(G.sand));
  ok("outline = road colour: 1:1 against the road (the fill behind the outline doesn't count at edge 1)", road && road.ratio.worst === 1 && road.ratio.median === 1 && road.under === 100, road);
  ok("…and the outline vs sand elsewhere", sand && sand.ratio.worst === Math.round(contrastRatio(G.road, G.sand) * 100) / 100, sand);
  const r3 = figureGround(sq, m2, { edge: 2 });
  ok("edge 2 reaches the fill behind a 1 px rim (anti-aliased sprites)", r3.surfaces.find((x) => x.hex === hex(G.road)).ratio.median === Math.round(contrastRatio(F, G.road) * 100) / 100);
  // textured ground merges into one surface (ΔE ≤ 12), a 1 px line is a minor surface
  const tx = img(40, 40, [60, 140, 60]);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if ((x + y) % 3 === 0) put(tx, x, y, [66, 150, 64]);
  rect(tx, 0, 20, 40, 1, [250, 250, 250]);
  const m3 = new Uint8Array(40 * 40); rect(tx, 15, 15, 10, 10, [200, 40, 40]); for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) m3[y * 40 + x] = 1;
  const r4 = figureGround(tx, m3, {});
  ok("textured grass is one surface; the 1 px white line is minor", r4.surfaces.length === 2 && !r4.surfaces[0].minor && r4.surfaces[1].minor && r4.surfaces[1].count === 2, r4.surfaces.map((s) => [s.hex, s.count, s.minor]));
  ok("figureGround: an empty mask is null", figureGround(tx, new Uint8Array(1600)) === null);
  // noisy grass around a flat square of nearly the same green: the ring splits into many surfaces, each under 5%;
  // they are judged together (the whole ring) instead of passing with nothing judged
  const nz = img(96, 96, [0, 0, 0]);
  let sd = 7;
  const rnd = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) put(nz, x, y, [Math.round(40 + 120 * rnd()), Math.round(100 + 110 * rnd()), Math.round(20 + 80 * rnd())]);
  const m4 = new Uint8Array(96 * 96);
  rect(nz, 24, 24, 48, 48, [0x64, 0x96, 0x46]); for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) m4[y * 96 + x] = 1;
  const r5 = figureGround(nz, m4, { merge: 8 });
  const whole = r5.surfaces.find((q) => q.combined);
  show("noisy ring", `${r5.surfaces.length - 1} surfaces, all minor: ${r5.surfaces.filter((q) => !q.combined).every((q) => q.minor)}; whole ring median ${whole && whole.ratio.median}`);
  ok("noisy ground: the 60 surfaces under 5% (94% of the ring) are judged together, median under 3:1", whole && whole.combined === 60 && whole.share > 0.9 && !whole.minor && whole.ratio.median < 3, r5.surfaces.map((q) => [q.hex, q.share, q.minor]));
  const r6 = figureGround(nz, m4, { merge: 8, minShare: 0.5 });
  const all6 = r6.surfaces.find((q) => q.combined);
  ok("no surface reaches minShare: the whole ring is judged (median = r.all's)", all6 && all6.hex === "the whole ring" && all6.share === 1 && all6.ratio.median === r6.all.ratio.median && all6.ratio.median < 3, all6);
  const cc = clusterColors(new Map([[0x102030, 5], [0x112131, 3], [0xffffff, 1]]), 12);
  ok("clusterColors: near colours join the most common one's cluster", cc.clusters.length === 2 && cc.clusters[0].count === 8 && cc.of.get(0x112131) === 0);
}

done("color");
