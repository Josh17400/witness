// Colour tests: `node tests/media/color.mjs` — colour-vision simulation, key colours and palette compliance, on
// synthesized pictures whose right answers are known by construction.
import {
  CVD_TYPES, cvdMatrix, simulateColor, simulateCVD, deltaE, contrastRatio, hex, dominantColors, pairsUnderCVD,
  parsePalette, paletteOfImage, paletteCheck, colorBudget, offPaletteImage,
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

done("color");
