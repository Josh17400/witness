// Scripted input spec shared by the CLI (--input) and the runtime (test blocks).
//
//   key@t              tap a key (down at t, up at t + 0.1)
//   key@a-b            hold a key from a to b
//   click:x,y@t        left click (UI pixels, top-left origin); click:x,y@a-b holds the button
//   rclick:x,y@t       right click (same forms)
//   mouse:x,y@t        move the mouse without clicking
//   drag:x1,y1->x2,y2@a-b   hold the left button and move linearly from a to b
//   wheel:+3@t         mouse wheel (+ = zoom out / scroll down)
//   click:world:x,y@t  coordinates in the 2D world instead of UI pixels (also mouse:/drag:)
//
// Items are separated by "," or ";". Anything not understood throws an Error naming the item.
// Events: {t, key, down} | {t, mouse:[x,y], down?, button, world?} | {t, wheel}

const NUM = "-?\\d+(?:\\.\\d+)?";
const TIME = `@(${NUM})(?:-(${NUM}))?`;
const RE = {
  key: new RegExp(`^([a-z0-9_]+)${TIME}$`, "i"),
  point: new RegExp(`^(click|rclick|mouse):(world:)?(${NUM}),(${NUM})${TIME}$`, "i"),
  drag: new RegExp(`^drag:(world:)?(${NUM}),(${NUM})->(${NUM}),(${NUM})${TIME}$`, "i"),
  wheel: new RegExp(`^wheel:([+-]?\\d+(?:\\.\\d+)?)@(${NUM})$`, "i"),
};
const EXAMPLES = "examples: right@0-2 (hold), space@1 (tap), click:640,360@1.5, mouse:100,200@2, drag:600,300->800,300@1-2, wheel:+3@1";

/** Split on separators without breaking "click:640,360@1" apart. */
export function splitItems(spec) {
  const items = [];
  let cur = "";
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === ";") { items.push(cur); cur = ""; continue; }
    if (c === ",") {
      // A comma inside a coordinate pair is followed by a number and preceded by one,
      // and the current item has a ':' but no '@' yet.
      const inCoords = /:/.test(cur) && !/@/.test(cur) && /^\s*-?\d/.test(spec.slice(i + 1)) && /\d\s*$/.test(cur);
      if (!inCoords) { items.push(cur); cur = ""; continue; }
    }
    cur += c;
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter(Boolean);
}

export function parseInputSpec(spec) {
  if (spec == null || spec === true || spec === "") return [];
  const ev = [];
  for (const item of splitItems(String(spec))) {
    let m;
    if ((m = RE.point.exec(item))) {
      const [, kind, world, x, y, a, b] = m;
      const t0 = +a, button = kind.toLowerCase() === "rclick" ? 2 : 0;
      const base = { mouse: [+x, +y], world: !!world, button };
      if (kind.toLowerCase() === "mouse") {
        if (b !== undefined) throw new Error(`'${item}': mouse: moves at one time; use drag: to move over a range`);
        ev.push({ t: t0, ...base });
      } else {
        const t1 = b !== undefined ? +b : t0 + 1 / 30;
        if (t1 <= t0) throw new Error(`'${item}': hold must end after it starts`);
        ev.push({ t: t0, ...base, down: true });
        ev.push({ t: t1, ...base, down: false });
      }
    } else if ((m = RE.drag.exec(item))) {
      const [, world, x1, y1, x2, y2, a, b] = m;
      if (b === undefined) throw new Error(`'${item}': drag needs a time range, e.g. drag:600,300->800,300@1-2`);
      const t0 = +a, t1 = +b;
      if (t1 <= t0) throw new Error(`'${item}': drag must end after it starts`);
      const steps = Math.max(2, Math.round((t1 - t0) * 30));
      ev.push({ t: t0, mouse: [+x1, +y1], world: !!world, button: 0, down: true });
      for (let i = 1; i < steps; i++) {
        const k = i / steps;
        ev.push({ t: t0 + (t1 - t0) * k, mouse: [+x1 + (x2 - x1) * k, +y1 + (y2 - y1) * k], world: !!world, button: 0 });
      }
      ev.push({ t: t1, mouse: [+x2, +y2], world: !!world, button: 0, down: false });
    } else if ((m = RE.wheel.exec(item))) {
      ev.push({ t: +m[2], wheel: +m[1] });
    } else if ((m = RE.key.exec(item))) {
      const [, name, a, b] = m;
      if (/^(click|rclick|mouse|drag|wheel)$/i.test(name)) throw new Error(`'${item}': ${name} needs a position — ${EXAMPLES}`);
      const t0 = +a, t1 = b !== undefined ? +b : t0 + 0.1;
      if (t1 <= t0) throw new Error(`'${item}': hold must end after it starts`);
      ev.push({ t: t0, key: name.toLowerCase(), down: true });
      ev.push({ t: t1, key: name.toLowerCase(), down: false });
    } else {
      throw new Error(`bad input item '${item}' — ${EXAMPLES}`);
    }
  }
  return ev.sort((p, q) => p.t - q.t);
}

/**
 * Witness: convert parsed events (times in seconds) to protocol events with frame numbers.
 * Also accepts already-protocol events (with `frame` or `t`).
 */
export function toProtocolEvents(events, fps) {
  const F = (t) => Math.max(0, Math.round(t * fps));
  return events.map((e) => {
    if (e.type) return { ...e, frame: e.frame ?? F(e.t ?? 0) };   // already protocol-shaped
    if (e.key) return { frame: F(e.t), type: "key", key: e.key, down: e.down };
    if (e.wheel != null) return { frame: F(e.t), type: "wheel", dy: e.wheel * 100 };
    if (e.mouse) {
      const ev = { frame: F(e.t), type: "mouse", x: e.mouse[0], y: e.mouse[1] };
      if (e.down !== undefined) { ev.button = e.button ?? 0; ev.down = e.down; }
      return ev;
    }
    return { frame: F(e.t || 0), ...e };
  });
}

/** Extended spec items: action:jump@1-2 (input-mapping actions), pad:a@1, text:hello@2 */
export function parseWitnessInput(spec, fps) {
  if (spec == null || spec === true || spec === "") return [];
  if (Array.isArray(spec)) return toProtocolEvents(spec, fps);
  const rest = [], extra = [];
  for (const item of splitItems(String(spec))) {
    const m = /^(action|pad|text):([^@]+)@(-?\d+(?:\.\d+)?)(?:-(-?\d+(?:\.\d+)?))?$/.exec(item.trim());
    if (!m) { rest.push(item); continue; }
    const [, kind, name, a, b] = m;
    const t0 = +a, t1 = b !== undefined ? +b : t0 + 0.1;
    if (kind === "text") { extra.push({ frame: Math.round(t0 * fps), type: "text", text: name }); continue; }
    const field = kind === "action" ? "action" : "button";
    extra.push({ frame: Math.round(t0 * fps), type: kind, [field]: name, down: true });
    extra.push({ frame: Math.round(t1 * fps), type: kind, [field]: name, down: false });
  }
  const base = rest.length ? toProtocolEvents(parseInputSpec(rest.join("; ")), fps) : [];
  return [...base, ...extra].sort((p, q) => p.frame - q.frame);
}
