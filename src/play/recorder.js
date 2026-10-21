// Witness play: record a playtest as a standard replay (docs/PROTOCOL.md §5) that `witness replay` reproduces
// frame-exactly. Sparse: only frames with input, marks or calls get a line, plus the last stepped frame, so the replay
// steps exactly as many frames as the session did.
import fs from "node:fs";

export class ReplayRecorder {
  constructor({ name = "game", seed = 1, fps = 60, scene = null, params = null, session = null, launch = null, epoch = null } = {}) {
    // launch: the browser it ran in ({engine, device}), so `witness replay` can say when it replays on another one
    this.head = { replay: 1, name, seed, fps, started: new Date().toISOString(), scene, params, source: "witness play", session, ...(epoch != null ? { epoch } : {}), ...(launch ? { launch } : {}) };
    this.fps = fps;
    this.frames = new Map();   // f → {in: [], marks: [], calls: []}
  }
  at(f) { let x = this.frames.get(f); if (!x) { x = { in: [], marks: [], calls: [] }; this.frames.set(f, x); } return x; }
  /** Record protocol events exactly as sent (order within a frame is kept). */
  add(events) { for (const e of events) { const { frame, ...rest } = e; this.at(frame).in.push(rest); } }
  mark(f, label) { this.at(f).marks.push(String(label).replace(/\s+/g, " ").slice(0, 200)); }
  call(f, name, args) { this.at(f).calls.push([name, ...(args || [])]); }

  /** JSONL text for a session that stepped `total` frames. */
  text(total) {
    const dt = 1 / this.fps, lines = [JSON.stringify(this.head)];
    const keys = [...this.frames.keys()].sort((a, b) => a - b);
    const out = new Map();
    for (const f of keys) {
      const x = this.frames.get(f);
      // input for frames that never ran is dropped; marks after the last step land on the last frame
      if (f < total) { const o = out.get(f) || { f, dt }; if (x.in.length) o.in = (o.in || []).concat(x.in); if (x.calls.length) o.calls = (o.calls || []).concat(x.calls); if (x.marks.length) o.marks = (o.marks || []).concat(x.marks); out.set(f, o); }
      else if (x.marks.length && total > 0) { const o = out.get(total - 1) || { f: total - 1, dt }; o.marks = (o.marks || []).concat(x.marks); out.set(total - 1, o); }
    }
    if (total > 0 && !out.has(total - 1)) out.set(total - 1, { f: total - 1, dt });
    for (const f of [...out.keys()].sort((a, b) => a - b)) {
      const o = out.get(f);
      const line = { f: o.f, dt: o.dt };
      if (o.in) line.in = o.in;
      if (o.marks) line.mark = o.marks.join(" | ");
      if (o.calls) line.calls = o.calls;
      lines.push(JSON.stringify(line));
    }
    return lines.join("\n") + "\n";
  }
  write(file, total) { fs.writeFileSync(file, this.text(total)); }
}
