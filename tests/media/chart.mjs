// Chart tests: `node tests/media/chart.mjs` (writes tests/media/out/chart-*.png to look at)
import { lineChart, renderChart, lanesFor, fmtTick } from "../../src/media/chart.js";
import { decodePNG } from "../../src/media/png.js";
import { ok, save, done } from "./harness.mjs";

console.log("chart");

// a trace like `witness trace` records: positions, a flag, a stat with a gap, a velocity
const series = (() => {
  const pos = [], posY = [], ground = [], hp = [], vel = [];
  for (let i = 0; i <= 600; i++) {
    const t = i / 60;
    pos.push([t, 120 + 380 * (1 - Math.cos(t * 0.6)) + 20 * Math.sin(t * 5)]);
    posY.push([t, 300 + 120 * Math.sin(t * 1.3)]);
    ground.push([t, Math.sin(t * 1.7) > 0.3]);
    hp.push([t, t > 4.2 && t < 5.1 ? null : Math.max(0, 100 - Math.floor(t * 7))]);
    vel.push([t, 2.5 * Math.cos(t * 0.6) + 0.3 * Math.sin(t * 9)]);
  }
  return [
    { label: "player.pos.x", points: pos }, { label: "player.pos.y", points: posY }, { label: "player.on_ground", points: ground },
    { label: "player.hp", points: hp }, { label: "player.vel.x", points: vel },
  ];
})();

{
  const png = lineChart({ title: "Embervale — player trace (seed 42)", series, markers: [{ t: 2.5, label: "F8 jump bug" }, { t: 2.9, label: "F8" }, { t: 7.25, label: "boss spawns" }] });
  save("chart-trace.png", png);
  const img = decodePNG(png);
  ok("default size 1280 wide", img.width === 1280 && img.height >= 640, [img.width, img.height]);
  // the boolean gets a lane of its own; pos.x and pos.y share one; hp and vel.x are separate
  const lanes = lanesFor(series.map((s) => {
    const valid = s.points.filter((p) => p[1] !== null).map((p) => [p[0], typeof p[1] === "boolean" ? +p[1] : p[1]]);
    return { label: s.label, valid, isBool: typeof s.points[0][1] === "boolean" };
  }));
  ok("lanes: 4 (positions together, flag alone, hp, velocity)", lanes.length === 4 && lanes[0].map((s) => s.label).join() === "player.pos.x,player.pos.y", lanes.map((l) => l.map((s) => s.label)));
}
{
  // a dark background, and the line colors actually reach the picture
  const r = renderChart({ title: "fps", series: [{ label: "fps", points: [[0, 60], [1, 59], [2, 58.5], [3, 31], [4, 60], [5, 60]] }], width: 900, height: 400 });
  save("chart-fps.png", r.toPNG());
  const bg = r.getPixel(2, 2);
  ok("dark background", bg[0] < 20 && bg[1] < 25 && bg[2] < 40, bg);
  let cyan = 0;
  for (let i = 0; i < r.data.length; i += 4) if (r.data[i] < 110 && r.data[i + 1] > 170 && r.data[i + 2] > 200) cyan++;
  ok("series drawn in its color", cyan > 400, cyan);
  ok("custom size honored", r.width === 900 && r.height === 400);
}
{
  // degenerate inputs never throw and still produce a readable picture
  const empty = decodePNG(lineChart({ title: "nothing yet", series: [] }));
  ok("no series → placeholder chart", empty.width === 1280);
  const junk = lineChart({ series: [{ label: "x", points: [[0, "NaN"], [1, null], [NaN, 3], ["2", 4], [3, Infinity], [4, "7"]] }] });
  ok("junk values → gaps, no throw", decodePNG(junk).width === 1280);
  const flat = lineChart({ title: "flat", series: [{ label: "c", points: [[1, 5], [1, 5]] }], markers: [{ t: 1, label: "only moment" }] });
  ok("single instant, flat value", decodePNG(flat).height > 0);
  const tiny = decodePNG(lineChart({ series: [{ label: "a", points: [[0, 1], [1, 2]] }], width: 10, height: 10 }));
  ok("size clamped to a legible minimum", tiny.width === 320 && tiny.height >= 200, [tiny.width, tiny.height]);
  const many = [];
  for (let k = 0; k < 9; k++) many.push({ label: `s${k}`, points: [[0, 0], [1, Math.pow(10, k)]] });
  const tall = decodePNG(lineChart({ title: "nine scales", series: many }));
  save("chart-many.png", lineChart({ title: "nine scales", series: many }));
  ok("many lanes grow the picture instead of squashing", tall.height > 640, tall.height);
}

{
  // B8: tick labels carry the decimals their step has (a 0.25 s step printed "0.3, 0.5, 0.8")
  ok("fmtTick B8: 0.25 step → 0.25", fmtTick(0.25, 0.25) === "0.25" && fmtTick(0.75, 0.25) === "0.75" && fmtTick(1.25, 0.25) === "1.25" && fmtTick(0, 0.25) === "0.00", [fmtTick(0.25, 0.25), fmtTick(0.75, 0.25)]);
  ok("fmtTick: 2.5 → 1 decimal, 5 → none, 0.1 → 1, 0.05 → 2", fmtTick(7.5, 2.5) === "7.5" && fmtTick(10, 5) === "10" && fmtTick(0.3, 0.1) === "0.3" && fmtTick(0.15, 0.05) === "0.15");
  ok("fmtTick: thousands", fmtTick(15000, 5000, 15000) === "15k" && fmtTick(2500000, 500000, 2500000) === "2.5M");
}
{
  // inputs (held keys) get rows under the plot; a series with no numbers stays in the legend as "no data"
  const pts = Array.from({ length: 61 }, (_, i) => [i / 60, 40 + 2 * i]);
  const spec = { title: "inputs", series: [{ label: "x", points: pts }, { label: "typo", points: pts.map(([t]) => [t, null]) }], width: 800, height: 400, fps: 60 };
  const plain = renderChart(spec), withIn = renderChart({ ...spec, inputs: [{ label: "right", t0: 0, t1: 0.5 }, { label: "space", t0: 0.25, t1: 0.35 }] });
  save("chart-inputs.png", withIn.toPNG());
  ok("inputs: the rows take room under the plot (never squash it below the minimum)", withIn.height >= plain.height, [plain.height, withIn.height]);
  let bar = 0;
  // rgba(142,202,230,0.85) over the dark background (11,16,32) ≈ (122,174,200)
  for (let i = 0; i < withIn.data.length; i += 4) if (Math.abs(withIn.data[i] - 122) < 8 && Math.abs(withIn.data[i + 1] - 174) < 8 && Math.abs(withIn.data[i + 2] - 200) < 8) bar++;
  ok("inputs: the held-key bars are drawn", bar > 300, bar);
  let legendDim = 0;
  for (let y = 60; y < 84; y++) for (let x = 0; x < withIn.width; x++) { const p = withIn.getPixel(x, y); if (Math.abs(p[0] - 0x8b) < 6 && Math.abs(p[1] - 0x93) < 6 && Math.abs(p[2] - 0xb8) < 6) legendDim++; }
  ok("no data: the empty series is still in the legend", legendDim > 20, legendDim);
}

done("chart");
