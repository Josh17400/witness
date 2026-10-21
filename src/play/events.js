// Witness play: notable events between two world models (hurt, hit, kill, pickup, alert, dialogue, death, goal ...),
// plus the report's accumulators: fights (encounters with damage dealt/taken and telegraph stats), deaths, pickups,
// dialogues. Events carry a `kind` the daemon uses to decide whether to wake the tester.
import { dist2, r1, clip, oneLine } from "./util.js";
import { thingLabel } from "./perceive.js";

const LOW_HP = 35;

/**
 * Damage over time (poison, burning, hunger) vs a hit: a small loss (8% of max hp, or 0.5 when the max isn't known)
 * with no enemy near, while no enemy in view is attacking, and either no enemy in view at all or another such loss
 * within 2.5 s (a periodic tick). Shared by the event tracker (wakes) and the autopilot (autofight's "X hit you").
 */
export class DotClassifier {
  constructor() { this.lastSmallT = null; }
  /** `near`: an enemy within 2.6× attack reach; `things`: the perceived things. True when the loss is a DoT tick. */
  loss(t, amount, maxHp, { near = false, things = [] } = {}) {
    const small = maxHp ? amount <= 0.08 * maxHp + 1e-9 : amount <= 0.5;
    if (near || !small) return false;
    const foes = things.filter((th) => th.rel === "hostile" && !th.dead);
    const attacking = foes.some((th) => th.telegraph || /attack|strike|shoot|fire|aim|cast|bite|hit|throw/i.test(th.state || ""));
    const periodic = this.lastSmallT != null && t - this.lastSmallT <= 2.5;
    this.lastSmallT = t;
    return !attacking && (!foes.length || periodic);
  }
}

export class EventTracker {
  constructor(cfg, perceiver) {
    this.cfg = cfg;
    this.perceiver = perceiver;
    this.fights = []; this.active = null; this.fightN = 0;
    this.deaths = []; this.pickups = []; this.dialogues = []; this.kills = [];
    this.tele = { windups: 0, avoided: 0, hits: 0 };
    this.pendingStrikes = [];   // {id, key, t}
    this.hurtTimes = [];        // t of every hurt
    this.alerted = new Set();   // hostiles already announced
    this.lastHurtBy = null;
    this.lowWarned = false;
    this.logRe = typeof cfg.logs === "string" ? new RegExp(cfg.logs, "i") : null;
    this.seenTypes = new Set();
    this.firstSight = [];       // {t, type, key} first time each hostile type is seen (for key-moment shots)
    this.recentLogs = [];       // game log lines of the last 1.5 s (death causes)
    this.drift = null;          // hp changes too small to show (regen ticks of 0.02): added up until they're worth a line
    this.goneAt = new Map();
    this.said = [];             // {t, k} notices and log lines of the last 2 s (one event when a game shows and logs a line)
    this.dot = new DotClassifier();    // id -> t of its last "is gone" (a thing flickering at the edge of the list is gone once)
  }

  /** prev may be null (the first snapshot). `ctx` = {lastAttackT, logs: [{frame, level, message}], fps}. Returns events. */
  update(prev, cur, ctx = {}) {
    const ev = [], t = cur.t, frame = cur.frame, cfg = this.cfg;
    const push = (kind, text, data) => ev.push({ t, frame, kind, text, data });
    // when the game logs the same moment in its own words ("You hit Wolf#3"), the inferred line is marked dup
    const logText = (ctx.logs || []).map((l) => String(l.message)).join(" | ").toLowerCase();
    const said = (key) => !!key && logText.includes(String(key).toLowerCase());
    const pushInf = (kind, text, data, key) => ev.push({ t, frame, kind, text, data, dup: said(key) || undefined });
    const reach = cfg.reach.attack;

    // game logs as events (the game's own words), errors always. A game that both shows a line (state.notice) and
    // logs it gets one event, not two (they can land a few frames apart: logs are read 4 times a second)
    this.said = this.said.filter((x) => t - x.t < 2);
    const sameSaid = (m) => { const k = sayKey(m); return !!k && this.said.some((x) => x.k === k); };
    for (const l of ctx.logs || []) {
      const msg = clip(oneLine(l.message), 160);
      if (l.level === "error") push("error", `game error: ${msg}`);
      else if (l.level === "warn") push("warn", `game warning: ${msg}`);
      else if (cfg.logs && (!this.logRe || this.logRe.test(msg))) { if (!sameSaid(l.message)) push("log", `game: "${msg}"`); this.said.push({ t, k: sayKey(l.message) }); }
    }
    if (!prev) {
      for (const th of cur.things) if (th.rel === "hostile" && th.dist <= cfg.alert) this.alerted.add(th.id);
      for (const th of cur.things) if (th.rel === "hostile" && !this.seenTypes.has(th.type)) { this.seenTypes.add(th.type); this.firstSight.push({ t, type: th.type, key: th.key }); }
      return ev;
    }
    const P = cur.player, PP = prev.player;

    // ---- player hp / death / respawn / goal
    if (P && PP && P.hp != null && PP.hp != null && P.hp !== PP.hp) {
      let d = P.hp - PP.hp, from = PP.hp;
      // regeneration and damage over time change hp by a sliver every tick: add those up (no "healed +0" lines) and
      // report them once they amount to something
      if (Math.abs(d) < 0.05) {
        if (!this.drift || Math.sign(this.drift.d) !== Math.sign(d)) this.drift = { d: 0, from: PP.hp };
        this.drift.d += d;
        if (Math.abs(this.drift.d) < 0.5) d = 0; else { d = this.drift.d; from = this.drift.from; this.drift = null; }
      } else this.drift = null;
      if (d < 0) {
        const src = cur.things.concat(prev.things).filter((th) => th.rel === "hostile" && th.dist <= reach * 2.6)
          .sort((a, b) => (b.telegraph || /strike|attack|bite|hit/i.test(b.state || "") ? 1 : 0) - (a.telegraph || /strike|attack|bite|hit/i.test(a.state || "") ? 1 : 0) || a.dist - b.dist)[0];
        this.lastHurtBy = src ? src.key : null;
        this.hurtTimes.push(t);
        // damage over time (poison, burning, hunger): timeline only, it doesn't wake the tester or stop an order (wake.js)
        const dot = this.dot.loss(t, -d, P.maxHp, { near: !!src, things: cur.things });
        ev.push({ t, frame, kind: "hurt", text: `you took ${r1(-d)} damage${src ? ` from ${src.key}` : ""} (hp ${r1(from)}→${r1(P.hp)})`, data: { amount: -d, by: src ? src.key : null, from, to: P.hp, ...(dot ? { dot: true } : {}) } });
        const pct = P.maxHp ? (100 * P.hp) / P.maxHp : null;
        const lowAt = Math.max(LOW_HP, ctx.retreat || 0);
        if (pct != null && pct < lowAt && pct > 0 && !this.lowWarned) { this.lowWarned = true; push("lowhp", `hp low: ${r1(P.hp)}/${r1(P.maxHp)}`); }
        if (this.active) this.active.taken += -d;
      } else if (d > 0) {
        push("heal", `healed +${r1(d)} (hp ${r1(from)}→${r1(P.hp)})`, { amount: d, from, to: P.hp });
        if (P.maxHp && (100 * P.hp) / P.maxHp >= LOW_HP + 10) this.lowWarned = false;
      }
    }
    for (const l of ctx.logs || []) this.recentLogs.push({ t, text: String(l.message) });
    this.recentLogs = this.recentLogs.filter((l) => t - l.t < 1.5);
    if (cur.dead && !prev.dead) {
      const cell = P && P.p2 ? cellOf(cur, P.p2) : null;
      // the game's own words beat our guess ("fell into a pit", "hit by Piranha#27")
      const said = this.recentLogs.slice().reverse().find((l) => /(died|death|killed|fell|pit|lava|drown|slain|you lose|game over)/i.test(l.text) && !/\b(player|you) (killed|defeated|slew)\b/i.test(l.text));   // not "player killed X"
      const cause = said ? clip(oneLine(said.text), 120) : this.lastHurtBy ? `last hit by ${this.lastHurtBy}` : "unknown";
      this.deaths.push({ t, cell, cause });
      push("death", `YOU DIED (${cause})`);
    }
    if (!cur.dead && prev.dead) { push("respawn", "respawned"); this.lowWarned = false; }
    if (cur.won && !prev.won) push("goal", "GOAL REACHED");
    if (cur.scene !== prev.scene && prev.scene != null) push("scene", `scene: ${prev.scene} → ${cur.scene}`);

    // ---- things that vanished / appeared / took damage
    const prevById = new Map(prev.things.map((th) => [th.id, th])), curById = new Map(cur.things.map((th) => [th.id, th]));
    const attackedRecently = ctx.lastAttackT != null && t - ctx.lastAttackT <= 0.6;
    const teamGame = !!(P && P.team != null);   // teammates shoot too: only count damage/kills while you were firing
    let dealtNow = 0;
    const killedNow = [];
    // a thing that flickers at the edge of the list (in, out, in, out) is gone once, not once per flicker
    const gone = (th, label) => {
      const last = this.goneAt.get(th.id);
      this.goneAt.set(th.id, t);
      this.perceiver.forget(th.id);
      if (last == null || t - last > 2) push("gone", `${label} is gone`, { id: th.id });
    };
    for (const [id, th] of prevById) {
      if (curById.has(id)) continue;
      // a corpse (kept as dead / state "dead") being cleaned up later isn't a second kill or a new fight
      if (th.dead) { this.perceiver.forget(id, "killed"); continue; }
      const near = th.dist <= 3.5, far = th.dist > Math.max(cur.maxListed, prev.maxListed) * 0.6 && th.dist > 8;
      if (th.rel === "hostile") {
        if ((th.hp != null && th.hp <= 2 && th.dist <= 6) || near || (!far && th.hp != null && th.maxHp && th.hp < th.maxHp)) {
          if (!teamGame || attackedRecently) this.kills.push({ t, key: th.key, type: th.type });
          killedNow.push(th);
          if (this.active && this.active.participants.has(id)) { this.active.kills++; this.active.participants.get(id).dead = true; if (th.hp != null) dealtNow += th.hp; }
          pushInf("kill", `${th.key} died`, { id }, th.key);
          this.perceiver.forget(id, "killed");
        } else if (!far) { gone(th, th.key); }
      } else if (th.rel === "item") {
        if (th.dist <= 2.2) { this.pickups.push({ t, key: th.key, type: th.type }); pushInf("pickup", `you picked up ${th.key}`, { id }, th.key); this.perceiver.forget(id, "picked up"); }
        else if (!far) { gone(th, th.key); }
      } else if (!far && th.dist <= 6) { gone(th, thingLabel(th)); }
    }
    for (const [id, th] of curById) {
      const was = prevById.get(id);
      // games that keep the dead in the list (dead: true / hp 0) instead of removing them
      if (was && !was.dead && th.dead && th.rel === "hostile") {
        if (!teamGame || attackedRecently) this.kills.push({ t, key: th.key, type: th.type });
        killedNow.push(was);
        if (this.active && this.active.participants.has(id)) { this.active.kills++; this.active.participants.get(id).dead = true; }
        if (was.hp != null && th.hp != null && was.hp > th.hp) dealtNow += was.hp - th.hp;
        pushInf("kill", `${th.key}${th.name ? ` "${th.name}"` : ""} died`, { id }, th.key);
        continue;
      }
      if (th.dead) continue;
      if (!was) {
        if (th.rel === "hostile" && !this.seenTypes.has(th.type)) { this.seenTypes.add(th.type); this.firstSight.push({ t, type: th.type, key: th.key }); }
        if (!this.perceiver.memory.has(id) || this.perceiver.memory.get(id).lastSeen >= t) {
          if (th.rel === "item" && th.dist <= cfg.alert * 1.5) push("appear", `a ${th.type} appeared ${r1(th.dist)} cells ${th.dir} (${th.key})`);
          else if (th.rel === "npc" && th.dist <= cfg.alert) push("appear", `${thingLabel(th)} appeared ${r1(th.dist)} cells ${th.dir}`);
        }
      } else if (th.hp != null && was.hp != null && th.hp < was.hp) {
        const d = was.hp - th.hp;
        if (th.rel === "hostile") {
          if (!teamGame || attackedRecently) dealtNow += d;
          const mine = attackedRecently && th.dist <= reach * 2;
          pushInf("hit", mine ? `you hit ${th.key} (-${r1(d)}, hp ${r1(th.hp)}${th.maxHp ? `/${r1(th.maxHp)}` : ""})` : `${th.key} took ${r1(d)} damage (hp ${r1(th.hp)})`, { id }, th.key);
        }
      }
      // telegraph edges
      if (th.rel === "hostile") {
        const wasT = was ? was.telegraph : false;
        if (th.telegraph && !wasT && th.dist <= reach * 3) { this.tele.windups++; if (this.active) this.active.windups++; this.pendingStrikes.push({ id, key: th.key, t0: t, strikeT: null }); }
        if (!th.telegraph && wasT) { const ps = this.pendingStrikes.find((s) => s.id === id && s.strikeT == null); if (ps) ps.strikeT = t; }
      }
      // alerts: a hostile comes within range
      if (th.rel === "hostile" && !th.dead) {
        if (th.dist <= cfg.alert && !this.alerted.has(id)) { this.alerted.add(id); push("alert", `${th.key} ${was ? "is closing in" : "appeared"}: ${r1(th.dist)} cells ${th.dir}`, { id }); }
        else if (th.dist > cfg.alert * 1.6) this.alerted.delete(id);
      }
    }
    // strikes resolve 0.3 s after the windup ends: hit if we got hurt in that window
    for (const s of this.pendingStrikes) {
      if (s.strikeT == null) { if (t - s.t0 > 3) s.done = true; continue; }
      if (t - s.strikeT >= 0.3) {
        const hit = this.hurtTimes.some((h) => h >= s.strikeT - 0.05 && h <= s.strikeT + 0.3);
        if (hit) { this.tele.hits++; if (this.active) this.active.hits++; } else { this.tele.avoided++; if (this.active) this.active.avoided++; }
        s.done = true;
      }
    }
    this.pendingStrikes = this.pendingStrikes.filter((s) => !s.done);
    this.hurtTimes = this.hurtTimes.filter((h) => t - h < 5);

    // ---- dialogue / notice / goal / menu
    const dj = (d) => (d ? JSON.stringify(d) : null);
    if (dj(cur.dialogue) !== dj(prev.dialogue)) {
      if (cur.dialogue) {
        const d = cur.dialogue;
        this.dialogues.push({ t, speaker: d.speaker, text: d.text, options: d.options });
        push("dialogue", `${prev.dialogue ? "dialogue" : "dialogue opened"} — ${d.speaker ? `${d.speaker}: ` : ""}"${clip(d.text, 120)}"${d.options.length ? ` [${d.options.map((o, i) => `${i + 1}) ${clip(o, 40)}`).join(" ")}]` : ""}`);
      } else push("dialogue-close", "dialogue closed");
    }
    if (cur.notice && cur.notice !== prev.notice) { if (!sameSaid(cur.notice)) push("notice", `game says: "${clip(oneLine(cur.notice), 140)}"`); this.said.push({ t, k: sayKey(cur.notice) }); }
    const gt = (g) => (g ? g.text : null);
    if (gt(cur.goal) !== gt(prev.goal) && cur.goal && cur.goal.text) push("goalchange", `goal: ${clip(cur.goal.text, 120)}`);
    if (!!cur.menu !== !!prev.menu) push("menu", cur.menu ? "a menu opened" : "the menu closed");
    // stats (gold 2→3); skip pure counters like time
    const ps = new Map(prev.stats.map((s) => [s.label, s.value]));
    // (turn profile: the shown fields include hands and tricks; only the short ones make "score 3→4" lines)
    const changes = cur.stats.filter((s) => ps.has(s.label) && JSON.stringify(ps.get(s.label)) !== JSON.stringify(s.value) && !/^(time|timer|clock|frame|t)$/i.test(s.label)
      && (cfg.profile !== "turn" || ((s.value == null || typeof s.value !== "object") && String(s.value).length <= 40)));
    if (changes.length && changes.length <= 3) push("stat", changes.map((s) => `${s.label} ${fmtV(ps.get(s.label))}→${fmtV(s.value)}`).join(", "));

    this.trackFight(prev, cur, ev, dealtNow, attackedRecently, killedNow);
    return ev;
  }

  trackFight(prev, cur, ev, dealtNow, attackedRecently, killedNow = []) {
    const t = cur.t, reach = this.cfg.reach.attack, P = cur.player;
    if (!P || !P.p2) return;
    if (cur.dead) { if (this.active) this.closeFight("lost", t); return; }   // no new fights while dead
    const hurt = ev.some((e) => e.kind === "hurt"), hit = ev.some((e) => e.kind === "hit" || e.kind === "kill");
    const close = cur.things.filter((th) => th.rel === "hostile" && !th.dead && th.dist <= Math.max(reach * 2.5, 2.5, this.cfg.profile === "fps" ? (this.cfg.fps.range ?? 12) * 1.5 : 0));
    if (!this.active) {
      if ((hurt || hit) && (close.length || hit)) {
        this.active = { n: ++this.fightN, t0: t, participants: new Map(), dealt: 0, taken: ev.filter((e) => e.kind === "hurt").reduce((a, e) => a + (e.data?.amount || 0), 0), kills: 0, windups: 0, avoided: 0, hits: 0, lastExchange: t };
      } else return;
    }
    const f = this.active;
    for (const th of close) if (!f.participants.has(th.id)) f.participants.set(th.id, { key: th.key, type: th.type, dead: false });
    // a one-hit kill (a stomp, a headshot) ends the fight in the same frame it starts: count the victim
    for (const th of killedNow) if (!f.participants.has(th.id)) { f.participants.set(th.id, { key: th.key, type: th.type, dead: true }); f.kills++; if (th.hp != null) f.dealt += th.hp; }
    f.dealt += dealtNow;
    if (hurt || hit) f.lastExchange = t;
    const alive = [...f.participants.entries()].filter(([id, p]) => !p.dead && cur.things.some((th) => th.id === id && !th.dead));
    for (const [id, p] of f.participants) if (!p.dead && !cur.things.some((th) => th.id === id && !th.dead)) p.dead = true;
    let result = null;
    if (cur.dead) result = "lost";
    else if (!alive.length && f.participants.size) result = "won";
    else if (t - f.lastExchange > 4 && !close.length) result = "broke off";
    if (result) this.closeFight(result, t);
  }

  closeFight(result, t) {
    const f = this.active; if (!f) return;
    this.active = null;
    const targets = [...f.participants.values()].map((p) => p.key);
    f.windups = Math.max(f.windups, f.avoided + f.hits);
    this.fights.push({ n: f.n, targets, start: +f.t0.toFixed(2), seconds: +Math.max(0, (result === "broke off" ? f.lastExchange : t) - f.t0).toFixed(2), result, dealt: +f.dealt.toFixed(2), taken: +f.taken.toFixed(2), kills: f.kills, windups: f.windups, avoided: f.avoided, hits: f.hits });
  }

  /** At session end: close an open fight. */
  finish(t) { if (this.active) this.closeFight("unresolved", t); }
}

/** A notice or log line as a comparison key: lowercase words only ("You won the trick!" = "you won the trick"). */
const sayKey = (m) => String(m ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const fmtV = (v) => (typeof v === "number" ? r1(v) : JSON.stringify(v));
export function cellOf(w, p2) { return [Math.floor((p2[0] - (w.origin?.[0] || 0)) / w.cell), Math.floor((p2[1] - (w.origin?.[1] || 0)) / w.cell)]; }
export { dist2 };

/**
 * Merge an observation's events for the reader: repeated heals become one "regenerated +12 over 5s" line, repeated
 * damage with no attacker one "took 6 damage over 3s" line, and the same text twice in half a second shows once.
 */
export function coalesceEvents(events) {
  const out = [], seen = new Map();
  // (a big heal among regen ticks, a potion, keeps its own line)
  const healsAll = events.filter((e) => e.kind === "heal" && e.data && e.data.amount != null);
  const med = healsAll.length ? healsAll.map((e) => e.data.amount).sort((x, y) => x - y)[Math.floor(healsAll.length / 2)] : 0;
  const heals = healsAll.filter((e) => e.data.amount <= Math.max(med * 3, 1));
  const dots = events.filter((e) => e.kind === "hurt" && e.data && e.data.amount != null && !e.data.by);
  const merged = new Set();
  const mergeOf = (list, fmt) => {
    if (list.length < 2) return;
    const sum = list.reduce((a, e) => a + e.data.amount, 0), a = list[0], z = list.at(-1);
    for (const e of list) merged.add(e);
    z.merged = { ...z, text: fmt(sum, z.t - a.t, a.data.from, z.data.to, list.length), data: { ...z.data, amount: sum, from: a.data.from, count: list.length } };
  };
  mergeOf(heals, (n, s2, a, b) => `regenerated +${r1(n)} over ${r1(Math.max(s2, 0.1))}s (hp ${r1(a)}→${r1(b)})`);
  mergeOf(dots, (n, s2, a, b, k) => `took ${r1(n)} damage over ${r1(Math.max(s2, 0.1))}s in ${k} hits, no attacker near (hp ${r1(a)}→${r1(b)})`);
  for (const e of events) {
    let x = e;
    if (merged.has(e)) { if (!e.merged) continue; x = e.merged; delete e.merged; }
    const prevT = seen.get(x.text);
    if (prevT != null && Math.abs(x.t - prevT) < 0.5) continue;
    seen.set(x.text, x.t);
    out.push(x);
  }
  return out;
}
