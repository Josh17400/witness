// Chart v2 tests: histograms, heat grids, path stats, world plots, A/B overlays on line charts.
// `node tests/media/plot.mjs` (writes tests/media/out/plot-*.png to look at)
import { histogram, sharedHistograms, percentile, heatGrid, pathStats, renderWorld, renderHist, heatColor, MARK_COLORS } from "../../src/media/plot.js";
import { renderChart, lanesFor } from "../../src/media/chart.js";
import { ok, save, done } from "./harness.mjs";

console.log("plot");

const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const count = (r, pred, rect = { x: 0, y: 0, w: r.width, h: r.height }) => {
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const p = r.getPixel(x, y); if (pred(p)) n++; }
  return n;
};
const close = (c, tol = 10) => (p) => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;

// ---- percentiles and histograms (known answers)
{
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  ok("percentile: median of 1..10 = 5.5, p5 = 1.45, p95 = 9.55", near(percentile(s, 0.5), 5.5) && near(percentile(s, 0.05), 1.45) && near(percentile(s, 0.95), 9.55), [percentile(s, 0.5), percentile(s, 0.05), percentile(s, 0.95)]);
  ok("percentile: ends are min and max", percentile(s, 0) === 1 && percentile(s, 1) === 10 && percentile([], 0.5) === null);

  // small integers: one bin per integer, exact counts
  const h = histogram([0, 1, 1, 2, 2, 2, 3, 3, 3, 3, null, "x", NaN, true]);
  ok("integer histogram: one bin per value 0..3", h.integer && h.bins.length === 4 && h.bins.map((b) => b.count).join() === "1,3,3,4" && h.bins[0].x0 === -0.5 && h.bins[3].x1 === 3.5, h.bins);
  ok("integer histogram: n skips null/strings/NaN, true counts as 1", h.n === 11 && h.mode.count === 4 && h.mode.x0 === 2.5, h.n);
  ok("integer histogram: stats", near(h.stats.mean, 21 / 11) && h.stats.median === 2 && h.stats.min === 0 && h.stats.max === 3, h.stats);

  // continuous: 0..99.9 in steps of 0.1 → 1000 values; a nice step of 5 gives 20 bins of exactly 50
  const vals = Array.from({ length: 1000 }, (_, i) => i / 10);
  const c = histogram(vals);
  ok("continuous histogram: 20 bins of 5, 50 values each", !c.integer && c.step === 5 && c.bins.length === 20 && c.bins.every((b) => b.count === 50), [c.step, c.bins.length, c.bins.map((b) => b.count).join()]);
  ok("continuous histogram: mean 49.95, median 49.95", near(c.stats.mean, 49.95, 1e-9) && near(c.stats.median, 49.95, 1e-9), c.stats);
  const st = histogram([0.5, 1.5, 2.5, 3.0], { step: 1 });
  ok("fixed step: [0,1) [1,2) [2,3) [3,4): the max lands in its own bin", st.bins.map((b) => b.count).join() === "1,1,1,1" && st.bins[0].x0 === 0, st.bins);
  const k = histogram([7.25, 7.25, 7.25]);
  ok("constant data: one bin", k.bins.length === 1 && k.bins[0].count === 3, k.bins);
  ok("no numbers: empty histogram, no throw", histogram([null, "a"]).n === 0 && histogram([]).bins.length === 0);

  // shared bins: A 0..9, B 5..14 → both on 0..14 integer bins
  const [A, B] = sharedHistograms([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]]);
  ok("shared histograms: same bins, each counted on its own", A.bins.length === 15 && B.bins.length === 15 && A.bins[0].x0 === B.bins[0].x0 && A.bins[14].count === 0 && B.bins[14].count === 1 && A.bins[0].count === 1 && B.bins[0].count === 0, [A.bins.length, B.bins.length]);
}

// ---- heat grids
{
  // 10 points in cell (0,0), 5 in (1,0), 1 in (-1,2) with a 16-unit cell
  const pts = [...Array(10).fill([3, 4]), ...Array(5).fill([20, 15.9]), [-0.5, 40]];
  const g = heatGrid(pts, { cell: 16 });
  ok("heatGrid: three cells, counts 10/5/1, sorted most first", g.cells.length === 3 && g.cells.map((c) => c.count).join() === "10,5,1" && g.total === 16 && g.max === 10, g.cells);
  ok("heatGrid: cell rects are exact (cell (1,0) = x 16..32, y 0..16; (-1,2) = x -16..0, y 32..48)", g.cells[1].x0 === 16 && g.cells[1].x1 === 32 && g.cells[1].y0 === 0 && g.cells[2].ix === -1 && g.cells[2].iy === 2 && g.cells[2].x0 === -16, g.cells);
  const o = heatGrid([[8, 8], [24, 8]], { cell: 16, origin: [8, 8] });
  ok("heatGrid: origin shifts the cells", o.cells.length === 2 && o.cells.every((c) => c.y0 === 8) && o.cells.map((c) => c.x0).sort((a, b) => a - b).join() === "8,24", o.cells);
  const w = heatGrid([[0, 0, 0.5], [1, 1, 1.5]], { cell: 10 });
  ok("heatGrid: weights add up", w.cells.length === 1 && w.cells[0].count === 2 && w.total === 2);
  const auto = heatGrid([[0, 0], [240, 100]]);
  ok("heatGrid: automatic cell ≈ span / 16, rounded up to a nice number (240 → 20)", auto.cell === 20, auto.cell);
  ok("heatColor: ramp ends", heatColor(0).join() === "59,15,112" && heatColor(1).join() === "252,253,191");
}

// ---- path stats
{
  const p = pathStats([[0, 0], [3, 4], [3, 10], [null, 2]]);
  ok("pathStats: length 5 + 6 = 11, net (3, 10), bounds", p.length === 11 && p.net.join() === "3,10" && p.bounds.x1 === 3 && p.bounds.y1 === 10 && p.samples === 3, p);
  ok("pathStats: no points → null", pathStats([]) === null);
}

// ---- world plot: equal scale, markers where they belong, map walls drawn
{
  // a 10×6 cell level of 16 units, walls round the edge; a path along the middle row
  const rows = ["##########", "#........#", "#........#", "#...##...#", "#........#", "##########"];
  const path = Array.from({ length: 61 }, (_, i) => [24 + 2 * i, 40]);
  const spec = {
    title: "path", width: 900, map: { cell: 16, origin: [0, 0], rows, solid: "#" },
    paths: [{ label: "player", points: path, ticks: [{ x: 84, y: 40, label: "0.5s" }] }],
    markers: [{ x: 24, y: 40, kind: "start", label: "start f0" }, { x: 144, y: 40, kind: "end", label: "end f60" }, { x: 100, y: 40, kind: "death", label: "death f38" }],
  };
  const r = renderWorld(spec);
  save("plot-world.png", r.toPNG());
  // the panel spans the map exactly (160×96 world) at one scale: width/height = 10/6
  let px0 = -1, px1 = -1;
  const mid = Math.round(r.height / 2);
  ok("world plot: legible size", r.width === 900 && r.height > 300, [r.width, r.height]);
  // find the start marker (green) and death marker (red) and check the x order and spacing match the world
  const findCentre = (pred) => { let sx = 0, sy = 0, n = 0; for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (pred(r.getPixel(x, y))) { sx += x; sy += y; n++; } return n ? [sx / n, sy / n, n] : null; };
  // markers in the legend share colors; look below the legend only
  const below = (pred) => (p) => pred(p);
  const green = findCentreBelow(r, close([0x3d, 0xdc, 0x97], 12), 110), red = findCentreBelow(r, close([0xff, 0x4d, 0x5e], 12), 110);
  ok("world plot: start and death markers drawn", green && red, [green, red]);
  if (green && red) {
    // world: start x=24, death x=100 → 76 units apart; the walls give the scale: 160 world units = panel width
    const wall = findWalls(r);
    const k = wall ? (wall.x1 - wall.x0) / 160 : 0;
    ok("world plot: markers sit at their world x (76 units apart at the map's scale)", wall && near(red[0] - green[0], 76 * k, 3), { dx: red[0] - green[0], want: 76 * k, wall });
    ok("world plot: equal scale (the 160×96 map draws with a 10:6 aspect)", wall && near((wall.x1 - wall.x0) / (wall.y1 - wall.y0), 160 / 96, 0.03), wall);
    // the path's row (cyan line) is y = 40: both marker centres, searched within 9 px of it, sit on it
    const cyan = findCentreBelow(r, close([0x4c, 0xc9, 0xf0], 8), 110);
    const band = (x, y) => Math.abs(y - cyan[1]) <= 9;
    const gm = findCentreBelow(r, close([0x3d, 0xdc, 0x97], 12), 110, band), rm = findCentreBelow(r, close([0xff, 0x4d, 0x5e], 12), 110, band);
    ok("world plot: start and death centred on the path's row (y = 40)", gm && rm && Math.abs(gm[1] - cyan[1]) < 1.5 && Math.abs(rm[1] - cyan[1]) < 1.5, [cyan, gm, rm]);
  }
  void px0; void px1; void mid; void below;
  const empty = renderWorld({ title: "nothing" });
  ok("world plot: nothing to plot → placeholder, no throw", empty.width === 1000 && empty.height >= 180);
  const single = renderWorld({ paths: [{ label: "p", points: [[5, 5]] }] });
  ok("world plot: a single point still renders", single.height > 0);
  const up = renderWorld({ yUp: true, paths: [{ label: "p", points: [[0, 0], [10, 10]] }], markers: [{ x: 0, y: 0, kind: "start" }, { x: 10, y: 10, kind: "end" }] });
  const s0 = findCentreBelow(up, close([0x3d, 0xdc, 0x97], 12), 110);
  ok("world plot --y-up: y = 0 is at the bottom", s0 && s0[1] > up.height / 2, s0);
}

// ---- heat layer + A/B paths
{
  const pts = [];
  for (let i = 0; i < 300; i++) pts.push([40 + (i % 60) * 2, 90]);   // a lane walked many times
  for (let i = 0; i < 120; i++) pts.push([150, 90]);                 // a long wait at one spot
  const grid = heatGrid(pts, { cell: 10 });
  const r = renderWorld({
    title: "heat", heat: { grid, label: "s", value: (c) => c / 60 },
    paths: [{ label: "A", points: [[40, 90], [160, 90]] }, { label: "B", points: [[40, 100], [200, 100]], dash: true }],
    markers: [{ x: 150, y: 90, kind: "death", label: "death ×2" }],
  });
  save("plot-heat.png", r.toPNG());
  // the 120-sample wait at (150, 90) is the hottest cell: pale yellow; the lane cells (5 samples each) are darker
  const pale = (p) => p[0] > 190 && p[1] > 190 && p[2] > 140;
  const hot = count(r, pale, { x: 0, y: 110, w: r.width, h: r.height - 110 });
  ok("heat layer: the hottest cell is drawn in the top colour", hot > 100, hot);
  ok("heat layer: the hot cell is where the wait was (x 150..160)", (() => { const c = findCentreBelow(r, pale, 110); const k = (r.width - 0) && c; return k && c[0] > r.width * 0.6 && c[0] < r.width * 0.75; })(), findCentreBelow(r, pale, 110));
}

// ---- histogram panels
{
  const a = Array.from({ length: 200 }, (_, i) => Math.round(3 * Math.sin(i / 7)));
  const b = a.map((v) => v + 1);
  const [ha, hb] = sharedHistograms([a, b]);
  const r = renderHist({ title: "speed", panels: [{ label: "vx", series: [{ label: "A", hist: ha }, { label: "B", hist: hb, dash: true }] }, { label: "only A", series: [{ label: "A", hist: histogram(a) }] }] });
  save("plot-hist.png", r.toPNG());
  ok("histogram picture: two panels, legible", r.width === 1000 && r.height > 400, [r.width, r.height]);
  ok("histogram picture: empty spec → placeholder", renderHist({}).height >= 200);
}

// ---- line chart overlays: lane keys keep A and B together, B dashed
{
  const A = { label: "x (A)", points: Array.from({ length: 61 }, (_, i) => [i / 60, 40 + 2 * i]), lane: "x" };
  const B = { label: "x (B)", points: Array.from({ length: 61 }, (_, i) => [i / 60, 1000 + 40 * i]), lane: "x", dash: true };
  const flag = { label: "f", points: [[0, false], [1, true]] };
  const lanes = lanesFor([A, B, flag].map((s) => ({ ...s, valid: s.points.map((p) => [p[0], +p[1]]), isBool: typeof s.points[0][1] === "boolean" })));
  ok("overlay: series with the same lane key share a lane however far apart their ranges", lanes.length === 2 && lanes[0].length === 2, lanes.map((l) => l.map((s) => s.label)));
  const r = renderChart({ title: "A vs B", series: [A, B], width: 800, height: 400 });
  save("plot-overlay.png", r.toPNG());
  ok("overlay: renders", r.width === 800);
}

function findCentreBelow(r, pred, y0, keep = () => true) {
  let sx = 0, sy = 0, n = 0;
  for (let y = y0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (pred(r.getPixel(x, y)) && keep(x, y)) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n, n] : null;
}
// label pills are drawn on rgba(11,16,32,0.85): a pixel whose 3-px left or right neighbour is that dark is text
function insideLabel(r, x, y) {
  for (const dx of [-4, 4]) { const p = r.getPixel(Math.max(0, Math.min(r.width - 1, x + dx)), y); if (p[0] < 30 && p[1] < 34 && p[2] < 50) return true; }
  return false;
}
function findWalls(r) {
  // wall colour #2f3658: its bounding box is the map
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  for (let y = 100; y < r.height; y++) for (let x = 0; x < r.width; x++) { const p = r.getPixel(x, y); if (Math.abs(p[0] - 0x2f) <= 2 && Math.abs(p[1] - 0x36) <= 2 && Math.abs(p[2] - 0x58) <= 2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  return x1 >= 0 ? { x0, x1: x1 + 1, y0, y1: y1 + 1 } : null;
}
void MARK_COLORS;

done("plot");
