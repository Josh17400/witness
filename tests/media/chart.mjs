// Chart tests: `node tests/media/chart.mjs` (writes tests/media/out/chart-*.png to look at)
import { lineChart, renderChart, lanesFor } from "../../src/media/chart.js";
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

done("chart");
