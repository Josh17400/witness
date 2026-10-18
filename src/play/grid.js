// Witness play: a navigation grid over the ground plane. Cells are blocked because the game's map says so
// (state.map), because walking into them failed (learned), or temporarily (something stood there). Unknown cells
// are optimistic: A* plans through them and replans when the player bumps into a wall ("free-space assumption").

const K = (x, y) => `${x},${y}`;
const unK = (k) => k.split(",").map(Number);
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, pri) {
    const a = this.a; a.push([pri, item]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top[1];
  }
}

export class NavGrid {
  constructor({ cell = 1, origin = [0, 0], northSign = -1 } = {}) {
    this.cell = cell;
    this.origin = origin;
    this.northSign = northSign;
    this.mapSolid = new Map();     // key → true (solid) | false (open), from the game's map
    this.hazard = new Set();       // map hazard cells (lava): treated as blocked for walking
    this.learned = new Map();      // key → {t, hits}
    this.temp = new Map();         // key → expiry time
    this.visited = new Set();      // cells the player stood in
    this.seen = new Set();         // cells within sight of the path
    this.bounds = null;            // {x0, y0, x1, y1} of map knowledge
    this.version = 0;              // bumps whenever blocking changes (paths need a replan)
    this.mapKey = null;
  }

  toCell(p) { return [Math.floor((p[0] - this.origin[0]) / this.cell), Math.floor((p[1] - this.origin[1]) / this.cell)]; }
  center(c) { return [this.origin[0] + (c[0] + 0.5) * this.cell, this.origin[1] + (c[1] + 0.5) * this.cell]; }

  /** Merge the game's map ({cell, origin, rows, solid, hazard}). Rows may be a window that moves with the player. */
  setMap(map) {
    if (!map) return;
    const key = map.rows.join("\n") + "|" + map.origin;
    if (key === this.mapKey) return;
    this.mapKey = key;
    // the map's grid must line up with ours; if the cell sizes differ, sample cell centres
    const solid = new Set(map.solid), hazard = new Set(map.hazard || "");
    const cx0 = Math.floor((map.origin[0] - this.origin[0]) / this.cell), cy0 = Math.floor((map.origin[1] - this.origin[1]) / this.cell);
    const same = Math.abs(map.cell - this.cell) < 1e-9;
    let changed = false;
    const put = (x, y, ch) => {
      const k = K(x, y), s = solid.has(ch), h = hazard.has(ch);
      if (this.mapSolid.get(k) !== s) { this.mapSolid.set(k, s); changed = true; }
      if (h && !this.hazard.has(k)) { this.hazard.add(k); changed = true; } else if (!h && this.hazard.delete(k)) changed = true;
      if (!s && this.learned.delete(k)) changed = true;     // the map is the truth: a learned wall here was a moving thing
      if (!s && this.temp.delete(k)) changed = true;
    };
    if (same) {
      for (let r = 0; r < map.rows.length; r++) { const row = map.rows[r]; for (let c = 0; c < row.length; c++) put(cx0 + c, cy0 + r, row[c]); }
      this.growBounds(cx0, cy0, cx0 + (map.rows[0]?.length || 0) - 1, cy0 + map.rows.length - 1);
    } else {
      const w = (map.rows[0]?.length || 0) * map.cell, h = map.rows.length * map.cell;
      const [ax, ay] = this.toCell(map.origin), [bx, by] = this.toCell([map.origin[0] + w - 1e-6, map.origin[1] + h - 1e-6]);
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
        const [px, py] = this.center([x, y]);
        const c = Math.floor((px - map.origin[0]) / map.cell), r = Math.floor((py - map.origin[1]) / map.cell);
        const ch = map.rows[r] ? map.rows[r][c] : undefined;
        if (ch !== undefined) put(x, y, ch);
      }
      this.growBounds(ax, ay, bx, by);
    }
    if (changed) this.version++;
  }

  growBounds(x0, y0, x1, y1) {
    const b = this.bounds;
    this.bounds = b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) } : { x0, y0, x1, y1 };
  }

  /** 'map' | 'hazard' | 'learned' | 'temp' | null (free or unknown). */
  blockedKind(x, y, t = 0) {
    const k = K(x, y);
    if (this.mapSolid.get(k) === true) return "map";
    if (this.hazard.has(k)) return "hazard";
    if (this.learned.has(k)) return "learned";
    const tm = this.temp.get(k);
    if (tm != null) { if (tm > t) return "temp"; this.temp.delete(k); }
    return null;
  }
  isBlocked(x, y, t = 0) { return this.blockedKind(x, y, t) != null; }
  known(x, y) { return this.mapSolid.has(K(x, y)) || this.visited.has(K(x, y)) || this.learned.has(K(x, y)); }
  isOpenKnown(x, y) { return this.mapSolid.get(K(x, y)) === false || this.visited.has(K(x, y)); }

  markBlocked(c, kind, t, ttl = 5) {
    const k = K(c[0], c[1]);
    if (this.visited.has(k) && kind === "learned") kind = "temp";   // we stood there before: a moving blocker, not a wall
    if (this.mapSolid.get(k) === false && kind === "learned") kind = "temp";
    if (kind === "temp") { this.temp.set(k, t + ttl); this.version++; return "temp"; }
    const prev = this.learned.get(k);
    this.learned.set(k, { t, hits: (prev?.hits || 0) + 1 });
    if (!prev) this.version++;
    return "learned";
  }

  visit(p, sight = 0) {
    const c = this.toCell(p), k = K(c[0], c[1]);
    let fresh = 0;
    if (!this.visited.has(k)) { this.visited.add(k); fresh++; }
    if (this.learned.delete(k)) this.version++;          // we're standing in it, so it isn't a wall
    const r = Math.max(0, Math.round(sight)), useLos = this.mapSolid.size > 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + 0.5) continue;
      const kk = K(c[0] + dx, c[1] + dy);
      if (useLos && (dx || dy) && !this.seen.has(kk) && !this.los(c, [c[0] + dx, c[1] + dy])) continue;   // no seeing through walls
      if (!this.seen.has(kk)) { this.seen.add(kk); fresh += 0.01; }
    }
    return fresh;
  }

  /** Cells on the segment a→b (supercover), excluding a. */
  line(a, b) {
    const out = [], seenL = new Set([K(a[0], a[1])]);
    const n = Math.max(1, 4 * Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])));
    let px = a[0], py = a[1];
    for (let i = 1; i <= n; i++) {
      const x = Math.round(a[0] + ((b[0] - a[0]) * i) / n), y = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
      if (x === px && y === py) continue;
      if (x !== px && y !== py) {   // a diagonal step: both side cells count (no squeezing between two corners)
        for (const c of [[x, py], [px, y]]) { const k = K(c[0], c[1]); if (!seenL.has(k)) { seenL.add(k); out.push(c); } }
      }
      const k = K(x, y);
      if (!seenL.has(k)) { seenL.add(k); out.push([x, y]); }
      px = x; py = y;
    }
    return out;
  }
  los(a, b, t = 0) { return this.line(a, b).every(([x, y]) => !this.isBlocked(x, y, t)); }

  /** Can a body of radius r (world units) move in a straight line from p to q (world points) without touching a blocked cell? */
  clearLine(p, q, r, t = 0) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.25)));
    const rr = r * 0.95;
    for (let i = 0; i <= n; i++) {
      const x = p[0] + ((q[0] - p[0]) * i) / n, y = p[1] + ((q[1] - p[1]) * i) / n;
      for (const [ox, oy] of [[-rr, -rr], [rr, -rr], [-rr, rr], [rr, rr]]) { const c = this.toCell([x + ox, y + oy]); if (this.isBlocked(c[0], c[1], t)) return false; }
    }
    return true;
  }

  /**
   * A* from cell a to cell b (8-connected, no corner cutting). Unknown cells cost a little more than known open ones.
   * Returns the cell path (including a and b) or null. `goalOk(x, y)` can accept a nearby goal (e.g. within reach).
   */
  astar(a, b, { t = 0, maxNodes = 40000, margin = 14, goalOk = null, unknownCost = 1.15 } = {}) {
    if (a[0] === b[0] && a[1] === b[1]) return [a];
    const box = { x0: Math.min(a[0], b[0]) - margin, y0: Math.min(a[1], b[1]) - margin, x1: Math.max(a[0], b[0]) + margin, y1: Math.max(a[1], b[1]) + margin };
    // with the game's map, the world ends at its edge: never plan around the outside of the level
    if (this.bounds) { box.x0 = Math.max(box.x0, this.bounds.x0); box.y0 = Math.max(box.y0, this.bounds.y0); box.x1 = Math.min(box.x1, this.bounds.x1); box.y1 = Math.min(box.y1, this.bounds.y1); }
    const inBox = (x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
    const h = (x, y) => { const dx = Math.abs(x - b[0]), dy = Math.abs(y - b[1]); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const open = new MinHeap(), g = new Map(), from = new Map();
    const sk = K(a[0], a[1]);
    g.set(sk, 0); open.push(sk, h(a[0], a[1]));
    let nodes = 0, best = sk, bestH = h(a[0], a[1]);
    while (open.size && nodes < maxNodes) {
      const k = open.pop(); nodes++;
      const [x, y] = unK(k);
      if ((x === b[0] && y === b[1]) || (goalOk && goalOk(x, y))) return this.trace(from, k);
      const hk = h(x, y);
      if (hk < bestH) { bestH = hk; best = k; }
      const gk = g.get(k);
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (!inBox(nx, ny)) continue;
        const isGoal = nx === b[0] && ny === b[1];
        if (this.isBlocked(nx, ny, t) && !isGoal) continue;
        if (dx && dy && (this.isBlocked(x + dx, y, t) || this.isBlocked(x, y + dy, t))) continue;   // no corner cutting
        const step = (dx && dy ? 1.4142 : 1) * (this.known(nx, ny) ? 1 : unknownCost);
        const nk = K(nx, ny), ng = gk + step;
        if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, k); open.push(nk, ng + h(nx, ny)); }
      }
    }
    this.lastPartial = best !== sk ? this.trace(from, best) : null;
    return null;
  }
  trace(from, k) { const out = [unK(k)]; while (from.has(k)) { k = from.get(k); out.push(unK(k)); } return out.reverse(); }

  /**
   * The best unvisited "frontier" cell to explore toward: open-or-unknown cells next to seen ones, scored by path
   * distance with a bonus in the requested direction. BFS from `start` through cells that aren't blocked.
   */
  frontier(start, { t = 0, dir = null, maxNodes = 30000, avoid = null } = {}) {
    const q = [[start[0], start[1], 0]], seenQ = new Set([K(start[0], start[1])]);
    let best = null, bestScore = -Infinity, nodes = 0;
    while (q.length && nodes < maxNodes) {
      const [x, y, d] = q.shift(); nodes++;
      const k = K(x, y);
      const unseen = !this.seen.has(k);
      const outside = this.bounds && (x < this.bounds.x0 || y < this.bounds.y0 || x > this.bounds.x1 || y > this.bounds.y1);
      if (unseen && !outside && !(avoid && avoid.has(k))) {
        let score = -d;
        if (dir) score += 2.5 * ((x - start[0]) * dir[0] + (y - start[1]) * dir[1]) / Math.max(1, Math.hypot(x - start[0], y - start[1])) * Math.min(d, 12);
        if (score > bestScore) { bestScore = score; best = [x, y]; }
        if (d > 60) break;
        continue;   // don't expand beyond the frontier
      }
      for (const [dx, dy] of N8.slice(0, 4)) {
        const nx = x + dx, ny = y + dy, nk = K(nx, ny);
        if (seenQ.has(nk) || this.isBlocked(nx, ny, t)) continue;
        if (this.bounds && (nx < this.bounds.x0 || ny < this.bounds.y0 || nx > this.bounds.x1 || ny > this.bounds.y1)) continue;
        seenQ.add(nk); q.push([nx, ny, d + 1]);
      }
    }
    return best;
  }

  /** Open cells the map knows (for coverage). */
  openCells() { let n = 0; for (const v of this.mapSolid.values()) if (v === false) n++; return n; }

  /** ASCII window around cell c (w×h). `marks` maps "x,y" → char (things). */
  render(c, w, h, marks = new Map(), t = 0) {
    const rows = [], x0 = c[0] - Math.floor(w / 2), y0 = c[1] - Math.floor(h / 2);
    for (let y = y0; y < y0 + h; y++) {
      let row = "";
      for (let x = x0; x < x0 + w; x++) {
        const k = K(x, y);
        if (x === c[0] && y === c[1]) { row += "@"; continue; }
        if (marks.has(k)) { row += marks.get(k); continue; }
        const kind = this.blockedKind(x, y, t);
        if (kind === "map" || kind === "learned") row += "#";
        else if (kind === "hazard") row += "^";
        else if (this.mapSolid.get(k) === false || this.visited.has(k)) row += ".";
        else row += "?";
      }
      rows.push(row);
    }
    return { rows, x0, y0 };
  }
}
