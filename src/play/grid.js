// Witness play: a navigation grid over the ground plane. Cells are blocked because the game's map says so
// (state.map), because walking into them failed (learned), or temporarily (something stood there). Unknown cells
// are optimistic: A* plans through them and replans when the player bumps into a wall ("free-space assumption").
// Cells to keep off (doors, stairs, exits: the map's door/avoid characters or things marked avoid) cost extra, so paths
// go round them unless the goal is there. When the game's map is a window that follows the player, everything outside
// the windows seen so far is unknown ground, not the edge of the world, and the windows are merged as they move.

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
    this.mapOrigin = null;
    this.windowed = false;         // the game's map is a window that moves with the player (its full size is unknown)
    this.avoidMap = new Set();     // cells the map marks as doors / to avoid (cost extra, never blocked)
    this.avoidThings = new Map();  // key -> thing: doors, stairs, exits listed this tick
    this.deadEnds = new Map();     // key -> times a path ended there without getting through (planned around next time)
  }

  toCell(p) { return [Math.floor((p[0] - this.origin[0]) / this.cell), Math.floor((p[1] - this.origin[1]) / this.cell)]; }
  center(c) { return [this.origin[0] + (c[0] + 0.5) * this.cell, this.origin[1] + (c[1] + 0.5) * this.cell]; }

  /** Merge the game's map ({cell, origin, rows, solid, hazard}). Rows may be a window that moves with the player. */
  setMap(map) {
    if (!map) return;
    const key = map.rows.join("\n") + "|" + map.origin;
    if (key === this.mapKey) return;
    this.mapKey = key;
    const o = String(map.origin);
    if (this.mapOrigin != null && this.mapOrigin !== o) this.windowed = true;   // sticky: a property of the game, kept across scenes
    this.mapOrigin = o;
    // the map's grid must line up with ours; if the cell sizes differ, sample cell centres
    const solid = new Set(map.solid), hazard = new Set(map.hazard || ""), avoid = new Set(map.avoid || "");
    if (map.window) this.windowed = true;
    const cx0 = Math.floor((map.origin[0] - this.origin[0]) / this.cell), cy0 = Math.floor((map.origin[1] - this.origin[1]) / this.cell);
    const same = Math.abs(map.cell - this.cell) < 1e-9;
    let changed = false;
    const put = (x, y, ch) => {
      const k = K(x, y), s = solid.has(ch), h = hazard.has(ch);
      if (this.mapSolid.get(k) !== s) { this.mapSolid.set(k, s); changed = true; }
      if (h && !this.hazard.has(k)) { this.hazard.add(k); changed = true; } else if (!h && this.hazard.delete(k)) changed = true;
      const a = avoid.has(ch) && !s;
      if (a && !this.avoidMap.has(k)) { this.avoidMap.add(k); changed = true; } else if (!a && this.avoidMap.delete(k)) changed = true;
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

  /** Forget everything (a new level or scene). */
  reset() {
    this.mapSolid.clear(); this.hazard.clear(); this.learned.clear(); this.temp.clear(); this.visited.clear(); this.seen.clear();
    this.avoidMap.clear(); this.avoidThings.clear(); this.deadEnds.clear();
    this.bounds = null; this.mapKey = null; this.mapOrigin = null; this.version++;
  }

  growBounds(x0, y0, x1, y1) {
    const b = this.bounds;
    this.bounds = b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) } : { x0, y0, x1, y1 };
  }

  /** Doors, stairs and exits listed now (things with `avoid`): replaces last tick's set. */
  setAvoidThings(things) {
    const m = new Map();
    for (const th of things) if (th.avoid && !th.dead && th.p2) { const c = this.toCell(th.p2); m.set(K(c[0], c[1]), th); }
    const same = m.size === this.avoidThings.size && [...m.keys()].every((k) => this.avoidThings.has(k));
    this.avoidThings = m;
    if (!same) this.version++;
  }
  /** Is this a cell to keep off (a door, stairs, an exit)? */
  isAvoid(x, y) { const k = K(x, y); return this.avoidMap.has(k) || this.avoidThings.has(k); }
  /** A path ended here without getting through: plan around it next time (an alternative instead of the same dead end). */
  addDeadEnd(c) { const k = K(c[0], c[1]); this.deadEnds.set(k, (this.deadEnds.get(k) || 0) + 1); this.version++; }
  deadEndPenalty(x, y) {
    if (!this.deadEnds.size) return 0;
    let p = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const n = this.deadEnds.get(K(x + dx, y + dy)); if (n) p += n * (3 - Math.max(Math.abs(dx), Math.abs(dy))); }
    return p;
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

  /** Can a body of radius r (world units) move in a straight line from p to q (world points) without touching a blocked cell? `avoid(x, y)` adds cells to keep off. */
  clearLine(p, q, r, t = 0, avoid = null) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.25)));
    const rr = r * 0.95;
    for (let i = 0; i <= n; i++) {
      const x = p[0] + ((q[0] - p[0]) * i) / n, y = p[1] + ((q[1] - p[1]) * i) / n;
      for (const [ox, oy] of [[-rr, -rr], [rr, -rr], [-rr, rr], [rr, rr]]) { const c = this.toCell([x + ox, y + oy]); if (this.isBlocked(c[0], c[1], t) || (avoid && avoid(c[0], c[1]))) return false; }
    }
    return true;
  }

  /**
   * A* from cell a to cell b (8-connected, no corner cutting). Unknown cells cost a little more than known open ones,
   * avoided cells (doors, stairs, exits) a lot more unless `exempt(x, y)` says they're the goal, and cells near a
   * recorded dead end more too. Returns the cell path (including a and b) or null (then `lastPartial` is the path to
   * the closest reachable cell). `goalOk(x, y)` can accept a nearby goal (e.g. within reach). The search box grows when
   * it was too small for the way round.
   */
  astar(a, b, { t = 0, maxNodes = 40000, margin = 14, goalOk = null, unknownCost = null, avoidCost = 12, exempt = null } = {}) {
    if (a[0] === b[0] && a[1] === b[1]) return [a];
    const uc = unknownCost ?? (this.windowed ? 1.3 : 1.15);
    let partial = null;
    for (const m of [margin, margin * 3, margin * 8]) {
      const r = this.astar1(a, b, { t, maxNodes, margin: m, goalOk, unknownCost: uc, avoidCost, exempt });
      if (r.path) { this.lastPartial = null; return r.path; }
      partial = r.partial;
      if (!r.boxLimited || r.outOfNodes) break;
    }
    this.lastPartial = partial;
    return null;
  }
  astar1(a, b, { t, maxNodes, margin, goalOk, unknownCost, avoidCost, exempt }) {
    const box = { x0: Math.min(a[0], b[0]) - margin, y0: Math.min(a[1], b[1]) - margin, x1: Math.max(a[0], b[0]) + margin, y1: Math.max(a[1], b[1]) + margin };
    // with the game's whole map, the world ends at its edge: never plan around the outside of the level. A window that
    // follows the player isn't the whole map, and neither is a map the goal lies outside of: beyond it is unknown ground.
    const bd = this.bounds, goalIn = bd && b[0] >= bd.x0 && b[0] <= bd.x1 && b[1] >= bd.y0 && b[1] <= bd.y1;
    let clipped = false;
    if (bd && !this.windowed && goalIn) { box.x0 = Math.max(box.x0, bd.x0); box.y0 = Math.max(box.y0, bd.y0); box.x1 = Math.min(box.x1, bd.x1); box.y1 = Math.min(box.y1, bd.y1); clipped = true; }
    const inBox = (x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
    const h = (x, y) => { const dx = Math.abs(x - b[0]), dy = Math.abs(y - b[1]); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const open = new MinHeap(), g = new Map(), from = new Map();
    const sk = K(a[0], a[1]);
    g.set(sk, 0); open.push(sk, h(a[0], a[1]));
    let nodes = 0, best = sk, bestH = h(a[0], a[1]) + this.deadEndPenalty(a[0], a[1]), boxLimited = false;
    while (open.size && nodes < maxNodes) {
      const k = open.pop(); nodes++;
      const [x, y] = unK(k);
      if ((x === b[0] && y === b[1]) || (goalOk && goalOk(x, y))) return { path: this.trace(from, k) };
      // the closest cell we can reach, but not one where a path already ended without getting through
      const hk = h(x, y) + this.deadEndPenalty(x, y);
      if (hk < bestH) { bestH = hk; best = k; }
      const gk = g.get(k);
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (!inBox(nx, ny)) { if (!clipped || !(nx < bd.x0 || ny < bd.y0 || nx > bd.x1 || ny > bd.y1)) boxLimited = true; continue; }
        const isGoal = nx === b[0] && ny === b[1];
        if (this.isBlocked(nx, ny, t) && !isGoal) continue;
        if (dx && dy && (this.isBlocked(x + dx, y, t) || this.isBlocked(x, y + dy, t))) continue;   // no corner cutting
        let step = (dx && dy ? 1.4142 : 1) * (this.known(nx, ny) ? 1 : unknownCost);
        if (avoidCost && !isGoal && this.isAvoid(nx, ny) && !(exempt && exempt(nx, ny))) step += avoidCost;
        if (this.deadEnds.size) step += this.deadEndPenalty(nx, ny);
        const nk = K(nx, ny), ng = gk + step;
        if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, k); open.push(nk, ng + h(nx, ny)); }
      }
    }
    return { path: null, partial: best !== sk ? this.trace(from, best) : null, boxLimited, outOfNodes: nodes >= maxNodes };
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
      const outside = this.bounds && !this.windowed && (x < this.bounds.x0 || y < this.bounds.y0 || x > this.bounds.x1 || y > this.bounds.y1);
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
        if (this.bounds && !this.windowed && (nx < this.bounds.x0 || ny < this.bounds.y0 || nx > this.bounds.x1 || ny > this.bounds.y1)) continue;
        seenQ.add(nk); q.push([nx, ny, d + 1]);
      }
    }
    return best;
  }

  /** Door cells (the map's door/avoid characters, or doors/stairs/exits listed as things) at or next to cell c, nearest first. */
  doorsNear(c, r = 1) {
    const out = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = c[0] + dx, y = c[1] + dy, k = K(x, y);
      if (this.avoidMap.has(k) || this.avoidThings.has(k)) out.push({ cell: [x, y], thing: this.avoidThings.get(k) || null, d: Math.hypot(dx, dy) });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /**
   * The open cell nearest to `target` that can be walked to from `from` (8-connected, no corner cutting, not through
   * doors/stairs/exits). Known open ground beats unknown ground at the same distance; ties go to the shorter walk.
   * Returns {cell, d} (d: cells from the target) or null.
   */
  nearestOpen(from, target, { t = 0, margin = 12, maxNodes = 20000 } = {}) {
    const box = { x0: Math.min(from[0], target[0]) - margin, y0: Math.min(from[1], target[1]) - margin, x1: Math.max(from[0], target[0]) + margin, y1: Math.max(from[1], target[1]) + margin };
    const bd = this.bounds;
    if (bd && !this.windowed) { box.x0 = Math.max(box.x0, bd.x0); box.y0 = Math.max(box.y0, bd.y0); box.x1 = Math.min(box.x1, bd.x1); box.y1 = Math.min(box.y1, bd.y1); }
    const q = [[from[0], from[1], 0]], seenQ = new Set([K(from[0], from[1])]);
    let best = null, bestS = Infinity, nodes = 0;
    while (nodes < q.length && nodes < maxNodes) {
      const [x, y, depth] = q[nodes++];
      const d = Math.hypot(x - target[0], y - target[1]);
      const s = d + (this.isOpenKnown(x, y) ? 0 : 0.5) + depth * 1e-3;
      if (s < bestS && !(x === target[0] && y === target[1])) { bestS = s; best = { cell: [x, y], d }; }
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy, nk = K(nx, ny);
        if (seenQ.has(nk) || nx < box.x0 || ny < box.y0 || nx > box.x1 || ny > box.y1) continue;
        if (this.isBlocked(nx, ny, t) || this.isAvoid(nx, ny)) continue;
        if (dx && dy && (this.isBlocked(x + dx, y, t) || this.isBlocked(x, y + dy, t))) continue;
        seenQ.add(nk); q.push([nx, ny, depth + 1]);
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
