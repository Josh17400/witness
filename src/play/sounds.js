// Witness play: what the game played, for a tester who can't hear. Names come from (best first) the game's own sound
// events (witness.sound("deny")), state.sounds in the snapshot, or log lines "sound: deny" / witness.log("sound",
// "deny"); with no names, the JS adapter's WebAudio start counter (perf.audio_started) says how many sounds played.
// The observation's events line shows "sounds: deny, hit ×3" or "sounds: 2 played" (docs/PLAYTEST.md, "Sounds").
import { clip, oneLine } from "./util.js";

/** A log line that names a sound: "sound: deny", "[sound] deny", or "sound deny" (witness.log("sound", "deny"): lowercase,
 *  exactly one word after it, so "Sound muted" / "sound engine failed to init" stay game messages). → name | null */
export function soundOfLog(msg) {
  const s = String(msg ?? "").trim();
  const m = /^(?:\[sound\]:?\s*|sound:\s*)(\S.*)$/i.exec(s) || /^sound (\S+)$/.exec(s);
  return m ? clip(oneLine(m[1]).replace(/^["']|["']$/g, ""), 32) : null;
}
const nameOf = (x) => (x == null ? null : typeof x === "object" ? x.name ?? x.id ?? x.sound ?? x.key ?? null : x);

export class SoundLog {
  constructor() { this.names = new Map(); this.played = 0; this.prev = null; this.seq = null; this.channel = false; this.audioAt = null; this.perfAudio = null; }
  add(name, k = 1) { const n = nameOf(name); if (n == null || n === "") return; const s = clip(oneLine(String(n)), 32); this.names.set(s, (this.names.get(s) || 0) + k); this.channel = true; }
  /**
   * state.sounds from one snapshot: an array of names since the last snapshot; a rolling array with a counter
   * (state.soundCount / soundSeq, or sounds: {count, recent: [...]}): the last count-new entries; an array that only
   * grows: its new tail. An unchanged array adds nothing (a game that never clears it isn't heard every frame).
   */
  fromState(st) {
    if (!st || typeof st !== "object") return;
    let list = st.sounds, count = st.soundCount ?? st.soundSeq ?? st.sounds_count ?? null;
    if (list && !Array.isArray(list) && typeof list === "object") { count = list.count ?? list.n ?? list.seq ?? count; list = list.recent ?? list.names ?? list.list ?? list.last ?? null; }
    if (!Array.isArray(list)) return;
    this.channel = true;
    if (typeof count === "number" && Number.isFinite(count)) {
      const fresh = this.seq == null ? 0 : Math.max(0, count - this.seq);
      this.seq = count;
      for (const x of list.slice(Math.max(0, list.length - fresh))) this.add(x);
      return;
    }
    const key = list.map((x) => String(nameOf(x)));
    const p = this.prev; this.prev = key;
    if (p && p.length === key.length && p.every((x, i) => x === key[i])) return;
    const grew = p && p.length < key.length && p.every((x, i) => x === key[i]);
    for (const x of grew ? key.slice(p.length) : key) this.add(x);
  }
  /** Game log lines: the sound lines are taken (and named), the others are handed back for the events tracker. */
  fromLogs(logs) {
    const rest = [];
    for (const l of logs || []) { const n = l.level !== "error" && l.level !== "warn" ? soundOfLog(l.message) : null; if (n) this.add(n); else rest.push(l); }
    return rest;
  }
  /** The game's own sound events ({event: "sound", name}). */
  fromEvents(evs) { for (const e of evs || []) this.add(e.name ?? "sound"); }
  /** A perf reply: perf.audio_started (sources the page started since the reset; also audio.started). False: no counter. */
  fromPerf(p) {
    const n = !p ? null : typeof p.audio_started === "number" ? p.audio_started : p.audio && typeof p.audio.started === "number" ? p.audio.started : null;
    if (n == null) { this.perfAudio = false; return false; }
    this.perfAudio = true; this.channel = true;
    if (this.audioAt != null) this.played += n >= this.audioAt ? n - this.audioAt : n;   // smaller: a reset zeroed it
    this.audioAt = n;
    return true;
  }
  /** What was heard since the last take: {names: [[name, count]], played} (played: unnamed starts), or null. Resets. */
  take() {
    const names = [...this.names.entries()], played = this.played;
    this.names = new Map(); this.played = 0;
    return names.length || played ? { names, played } : null;
  }
}

/** "sounds: deny, hit ×3" (named) · "sounds: 2 played" (counted) · "sounds: none" (an order ran, the game can tell, nothing played). */
export function soundsText(h, { quietOk = false } = {}) {
  if (!h) return quietOk ? "sounds: none" : null;
  if (h.names && h.names.length) {
    const shown = h.names.slice(0, 8);
    return `sounds: ${shown.map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(", ")}${h.names.length > shown.length ? ` (+${h.names.length - shown.length} more)` : ""}`;
  }
  return h.played ? `sounds: ${h.played} played` : quietOk ? "sounds: none" : null;
}
