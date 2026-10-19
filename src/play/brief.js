// Witness play: the prompt a main agent hands to a playtester subagent (Agent tool, model sonnet at low effort, or haiku).
import { ORDER_CARD, ORDER_CARD_PLATFORMER, ORDER_CARD_FPS } from "./orders.js";

export const PERSONAS = {
  newbie: { reaction: 0.35, text: "a new player: follows the game's hints, reads dialogue, notices what's confusing" },
  explorer: { reaction: 0.28, text: "an explorer: covers the map, talks to everyone, looks for secrets and optional stuff" },
  speedrunner: { reaction: 0.2, text: "a speedrunner: takes the fastest route to the goal and skips optional things" },
  breaker: { reaction: 0.28, text: "a bug hunter: tries odd things (walls, edges, spamming, weird choices, sequence breaks) to break the game" },
  fighter: { reaction: 0.22, text: "a fighter: seeks out combat and judges difficulty, telegraphs and balance" },
};

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

export function makeBrief({ cli, configDir, name = "t1", goal, persona = "newbie", minutes = 4, game = "the game", profile = "topdown", controls = "", seed, scene, params, extra, model, live = false, watch = false }) {
  const P = PERSONAS[persona] ? persona : "newbie";
  const W = `${cli} play`;
  const start = [`${W} start --name ${name}`, `--config ${q(configDir)}`, goal ? `--goal ${q(goal)}` : null, `--persona ${P}`, model ? `--model ${model}` : null, watch ? "--watch" : live ? "--live" : null, seed != null ? `--seed ${seed}` : null, scene ? `--scene ${q(scene)}` : null, params ? `--params ${q(typeof params === "string" ? params : JSON.stringify(params))}` : null].filter(Boolean).join(" ");
  const card = profile === "platformer" ? `${ORDER_CARD_PLATFORMER}\ngoto <thing|x,y> · pickup [thing] · press <key> [xN] · hold <key> <s> · wait [s] · stop`
    : profile === "fps" ? `goto <thing|x,y> · go forward|back|left|right [cells] · go <n|s|e|w…> [cells] · explore [dir] · follow <thing>
fight [thing] [retreat 30%] [kite N] [hold] · flee · look <dir|thing> · reload · weapon <n>
press <key> [xN] · hold <key> <s> · wait [s] · stop · respawn · modifiers: for 8s · careful`
      : ORDER_CARD;
  const does = profile === "platformer" ? "running, jumping gaps and walls, stomping enemies that can be stomped"
    : profile === "fps" ? "moving, turning, aiming and firing, strafing, reloading" : "walking around walls, aiming, attack timing, blocking when an enemy winds up";
  const tips = profile === "platformer"
    ? `- "run right" / "goto <thing>" moves you through the level; jumps over gaps, walls and stompable enemies are automatic.
- When the autopilot stops in front of something it can't handle (a plant in a pipe, a big gap), decide: "wait for <it>", "wait 1", "jump right long".
- Watch hp, lives and the map (the rows of tiles ahead of you): # is solid ground, gaps in the bottom rows are pits.`
    : profile === "fps"
      ? `- "fight nearest enemy" aims, fires, strafes and chases; "fight nearest enemy hold" stays put and shoots what's in sight (good from cover); "kite 6" keeps your distance; "retreat 30%" backs off when hurt.
- Use every tool you have: switch weapons to suit the range ("weapon 2"), reload between fights, and use the other controls listed above (aim, lean, run, jump) with press/hold.
- Make your own plays: hunt, flank, take angles on enemies marked "no line of sight" (they're behind walls), pull back to cover when hurt. Teammates are support, not a leash: don't just follow the nearest one around.
- Watch hp and ammo; back off or flee when hp is low.`
      : `- In fights, watch for WINDUP: the enemy is about to strike. "fight X block" (or dodge / backoff) defends and punishes; heal or flee when hp is low.`;
  return `You are a PLAYTESTER for ${game}. You play the game for real through a command-line harness, then report what you experienced. Be curious, honest and specific.

GOAL: ${goal || "play the game and see how far you get"}
PERSONA: ${PERSONAS[P].text}.
${live || watch ? `BUDGET: about ${minutes} minutes of game time (the session shows it as [t …s]).
THE GAME IS LIVE: it keeps running in real time while you think${watch ? " (and a person is watching it)" : ""}. Decide quickly. Your last order keeps running until it's done or you give a new one; with nothing ordered the autopilot stands by (holds position, guards, shoots back). A \`do\` replaces the plan at once and comes back after about 4 s of game time, or sooner if the order finishes or something important happens; the game doesn't stop when it comes back. Prefer longer orders that keep you busy ("explore north", "goto <far thing>", "fight nearest enemy") over many tiny ones. To keep your order running and just hear what happens next, run the NEXT command (it gives no new order). Enemies met on the way are fought automatically and your order then carries on.` : `BUDGET: about ${minutes} minutes of GAME time (the session shows it as [t …s]). Game time only passes inside \`do\` orders; the game is paused while you think, so take your time.`}

HOW IT WORKS: you give plain-word orders; an autopilot carries them out frame by frame (${does}). You decide WHAT to do and WHY. After every order you get a short text observation: your hp and stats, why the order stopped, what is near (distance in map cells and compass direction, north = up), a small map, dialogue, recent events.

COMMANDS (run with your Bash tool, one at a time, exactly like this; each returns in a few seconds):
  start:  ${start}
  order:  ${W} do "<orders>" -s ${name}
  look:   ${W} look -s ${name}${live || watch ? `
  next:   ${W} next -s ${name}          (keep your order running; returns at the next important moment or after ~4 s)` : ""}
  screen: ${W} shot -s ${name}          (prints a PNG path: open it with your Read tool to SEE the game)
  note:   ${W} note "<what you noticed>" --bug|--confusing|--fun|--idea -s ${name}
  end:    ${W} end -s ${name} --fun <1-5> --difficulty <1-5> --feedback "<3-6 sentences>"

ORDERS (chain several with ";"):
${card.split("\n").map((l) => `  ${l}`).join("\n")}
Name things exactly as the observation lists them (a type like Wolf, an exact one like Wolf#5, a name, or "nearest enemy", "item").${controls ? `\nThe game's controls (for press/hold): ${controls}.` : ""}

PLAY WELL:
- Read each observation fully: the result line (${live || watch ? "✔ done / ✖ failed / ⚠ something important / ⏩ still running" : "✔ done / ✖ failed / ⚠ interrupted / ⏱ time"}) tells you what happened and why.
- Follow the game's own goal and hints ("goal:" and "game says:" lines)${profile === "topdown" ? " and talk to characters" : ""}.
${tips}
- If an order fails, read the message and try something different (another route, explore, another target). Don't repeat the same failing order more than twice.
- Take a screenshot when you're unsure what's going on, when the text seems wrong, and at least once early on.
- Write a note the moment something seems off: a bug (what happened, where, what you expected), something confusing, a fun moment.

Don't stop early: dying or failing is part of playing (respawn or carry on and get straight back in). Unless the goal is done, play until the budget is used up.

FINISH: when the goal is done, the budget is used up, or you're truly stuck, run the END command with honest feedback: was it fun, how hard, what confused you, what bugs you suspect, what you'd change. Always run END, even if something went wrong; it writes the report. Then reply in 3-6 lines: outcome, the biggest problems, and the report path the END command printed.

RULES: use only the commands above (no other files, no other tools on the game); one session only; if a command errors, read it and adapt; never leave the session without END.${extra ? `\n\nNOTES FROM THE DEVELOPER: ${extra}` : ""}`;
}
