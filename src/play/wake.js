// Witness play: when a running `do` hands control back to the tester (the wake rules in docs/PLAYTEST.md).
// Pure: the daemon and the unit tests share it.

/**
 * The text of the first event that should wake the tester, or null. `b` = {verb, careful, target} of the running
 * order; `ctx` = {ap, world, cfg, live}.
 */
export function wakeFor(ev, b, { ap, world, cfg, live = false }) {
  const combat = ap.inCombat(), careful = b && b.careful;
  // with autofight on, enemies met while moving are the reflex layer's job: only the big things wake the tester
  const moving = /^(goto|go|explore|follow|pickup|talk|run)$/.test(b?.verb || "") || !!ap.suspended;
  const reflexes = ap.policy.autofight && (moving || live);
  for (const e of ev) {
    // a scene change the order caused on purpose (it walked into the inn it was sent to) finishes it instead
    if (e.kind === "scene" && ap.sceneArrival) continue;
    if (["death", "goal", "error", "scene", "lowhp"].includes(e.kind)) return e.text;
    if (world.dead && (e.kind === "alert" || e.kind === "hurt")) continue;
    // damage over time (poison ticks, no attacker): timeline only; low hp and death still wake
    if (e.kind === "hurt" && e.data && e.data.dot) continue;
    if (e.kind === "dialogue" && !/^(talk|interact|choose|press|use)$/.test(b?.verb || "")) return e.text;
    if (reflexes && (e.kind === "hurt" || e.kind === "alert")) continue;
    if (!combat && e.kind === "hurt" && b?.verb !== "flee") return e.text;
    // platformer runs jump or stomp enemies on their own: an approaching enemy isn't worth a wake there
    const runner = cfg.profile === "platformer" && /^(run|goto|go|explore|pickup|jump)$/.test(b?.verb || "");
    if (!combat && !runner && e.kind === "alert" && b?.verb !== "flee" && !(b?.target != null && e.data && String(e.data.id) === String(b.target))) return e.text;
    if (careful && ["appear", "notice", "pickup", "kill"].includes(e.kind)) return e.text;
  }
  return null;
}
