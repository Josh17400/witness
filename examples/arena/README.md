# arena: a small top-down action game for agent playtests

A headless Node game built on the JS adapter (`adapters/js/witness.js`), made for the agent playtest harness
(`docs/PLAYTEST.md`; design notes in `docs/PLAYTEST_PLAN.md` §11). Coins is too simple to test a playing agent. Arena needs the things an agent has to
get right:

* **a maze** where walking in a straight line gets you stuck (the direct line from the start to the exit is walled);
* **wolves that telegraph their bites**: each one stops and *winds up* for 0.5 s (the Alpha Wolf 0.6 s) before it
  strikes. If you trade hits with several wolves you lose. If you read the windups you win;
* **an NPC dialogue** with two options, **pickups**, a **locked gate** (the Alpha Wolf drops the key) and an **exit**.

The map is 30×18 tiles of 16 px (480×288). From the start room in the west, go through the maze to the wolf courtyard
(north-east). The Alpha Wolf's den opens off the courtyard's south side. The goal room (south-east) is reachable only
through the gate.

## Controls

| key | action |
|---|---|
| WASD / arrows | move (8 directions). `facing` = the last direction moved |
| `j` / `space` | attack: a 0.1 s swing, ±75° in front, reach 22 px, cooldown 0.4 s. 1 damage, or 2 against a staggered wolf |
| `k` (hold) | block: half speed, no attacks. A bite from within ±90° of your facing does no damage and staggers the wolf for 1 s |
| `l` / `shift` | dodge: a 0.18 s dash with no damage taken, cooldown 0.7 s |
| `e` | talk to the Old Guard / open the gate (you need the key) |
| `q` | drink a potion (+4 hp) |
| `1` / `2` | choose a dialogue option (`escape` closes the dialogue) |
| `enter` | respawn after dying |

## Snapshot conventions it shows

```
scene, time, won, dead, deaths, quest, notice, goal: {text},
player:   {id: 1, type: "Player", pos, hp, maxHp, facing, attacking, blocking, dodging, potions, gold, hasKey}
entities: [player, ...] sorted by id:
  Wolf / AlphaWolf {name, hp, maxHp, hostile: true, state: idle|chase|windup|strike|recover|stagger, telegraph: <s left>}
  Guard {name: "Old Guard", talk: true, hostile: false}    Potion / Coin / Key {item: true}
  Gate {locked}    Exit
dialogue: null | {speaker, text, options}
map: {cell: 16, origin: [0, 0], rows: ["#...", ...], solid: "#G"}   ('G' = closed gate, 'X' = exit)
digest: a hash of the full internal state (exact floats, timers, held keys, rng draws)
```

Positions are `[x, y]` pixel centres. Game events are info logs (`Wolf#3 bites you (-2)`,
`You block Wolf#3's bite. It staggers!`, `The Alpha Wolf drops the key!` ...). Ids follow map order, whatever the
reset params: player 1, Wolf 3/5/8, Old Guard 6, Gate 9, Alpha Wolf 12, Exit 13.

**Test setup.** Reset params: `start` (`start` | `maze` | `courtyard` | `alpha` | `gate`), `god`, `wolves: false`,
`key`, `quest`. Calls: `teleport x y`, `give potion|coin|key [n]`, `sethp n`, `kill <id|type> ...`, `open`.

## Run it

No build step and no dependencies (Node 18+). From this folder:

```
node ../../bin/witness.js doctor
node ../../bin/witness.js test              # witness/arena.witness.json: walls, sliding, windup → bite, block → stagger,
                                            # dialogue, potion, key → gate → exit, death/respawn, map reachability
node ../../bin/witness.js shot --at 0.6 --params '{"start":"courtyard"}' --input "right@0-0.1, k@0.15-1"
```

To play it yourself, run `node game.mjs` in a terminal: an ASCII version (`!` = a wolf winding up, `z` = staggered, `x`
quits, `m` marks a moment). Set `WITNESS_RECORD=witness/replays/run.jsonl` to record the session, then
`node ../../bin/witness.js replay last`. Without a terminal it runs a 1.5 s scripted demo and prints the final
position.
