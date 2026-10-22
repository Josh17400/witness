// Witness play: when a running `do` hands control back to the tester (the wake rules in docs/PLAYTEST.md).
// Pure: the daemon and the unit tests share it.

/**
 * The text of the first event that should wake the tester, or null. `b` = {verb, careful, quiet, target} of the running
 * order; `ctx` = {ap, world, cfg, live}.
 */
export function wakeFor(ev, b, { ap, world, cfg, live = false }) {
  const combat = ap.inCombat(), careful = b && b.careful;
  // with autofight on, enemies met while moving are the reflex layer's job: only the big things wake the tester
  const moving = /^(goto|go|explore|follow|pickup|talk|run)$/.test(b?.verb || "") || !!ap.suspended;
  const reflexes = ap.policy.autofight && (moving || live);
  // alerts only wake when play.alerts is on (a defense game lists them as events: enemies coming is its normal state),
  // and a quiet order ("wait 5 quiet") wakes only for the big things; a defense game isn't woken by the base taking hits
  const calm = (b && b.quiet) || cfg.alerts !== true, tough = (b && b.quiet) || cfg.profile === "defense";
  for (const e of ev) {
    // a scene change the order caused on purpose (it walked into the inn it was sent to) finishes it instead
    if (e.kind === "scene" && ap.sceneArrival) continue;
    // turn/menu games: a new screen is what the pick or the wait was for; the order's own result reports it
    if (e.kind === "scene" && cfg.profile === "turn") continue;
    if (["death", "goal", "error", "scene", "lowhp"].includes(e.kind)) return e.text;
    if (world.dead && (e.kind === "alert" || e.kind === "hurt")) continue;
    // damage over time (poison ticks, no attacker): timeline only; low hp and death still wake
    if (e.kind === "hurt" && e.data && e.data.dot) continue;
    if (e.kind === "dialogue" && !/^(talk|interact|choose|press|use)$/.test(b?.verb || "")) return dialogueWake(e, b, ap);
    if (reflexes && (e.kind === "hurt" || e.kind === "alert")) continue;
    if ((calm && e.kind === "alert") || (tough && e.kind === "hurt")) continue;
    if (b && b.quiet && ["appear", "notice", "pickup", "kill"].includes(e.kind)) continue;
    if (!combat && e.kind === "hurt" && b?.verb !== "flee") return e.text;
    // platformer runs jump or stomp enemies on their own: an approaching enemy isn't worth a wake there
    const runner = cfg.profile === "platformer" && /^(run|goto|go|explore|pickup|jump)$/.test(b?.verb || "");
    if (!combat && !runner && e.kind === "alert" && b?.verb !== "flee" && !(b?.target != null && e.data && String(e.data.id) === String(b.target))) return e.text;
    if (careful && ["appear", "notice", "pickup", "kill"].includes(e.kind)) return e.text;
  }
  return null;
}

/**
 * The wake line for a dialogue that stopped an order (a perk pick every few waves stops a chain of fights): what
 * stopped, what to do (choose 1-3) and that the rest of the chain didn't run, so the tester chooses, then carries on.
 */
export function dialogueWake(e, b, ap) {
  const n = e.data && e.data.options != null ? e.data.options : 0, left = ap && ap.queue ? ap.queue.length : 0;
  const what = e.data && e.data.opened === false ? "the dialogue changed" : "a dialogue opened";
  const todo = n ? `choose ${n > 1 ? `1-${n}` : "1"}` : "press confirm or cancel to close it";
  return `stopped${b && b.verb ? ` ${b.verb}` : ""}: ${what} (${todo}, then give your orders again${left ? `; ${left} queued order${left > 1 ? "s" : ""} not run` : ""}) — ${e.text.replace(/^dialogue( opened)? — /, "")}`;
}
