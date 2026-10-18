"""Coins in pygame (pygame or pygame-ce): the Witness sample game written the pygame way.

    python coins_pygame.py                play in a window (arrows/WASD, F8 = replay mark)
    witness doctor / witness test         run from this folder

The usual pygame loop is split into `frame(dt)` (events, update, draw) so the same code runs
in real time (driven by pygame.time.Clock) and under Witness (driven by `step` commands).
Input is read with pygame.key.get_pressed() and pygame events, exactly as a normal game would;
witness_pygame.Bridge injects Witness input through those paths.
"""

import math
import os
import random
import sys

_REPO_ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "adapters", "python")
if os.path.isfile(os.path.join(_REPO_ADAPTER, "witness.py")):
    sys.path.insert(0, os.path.normpath(_REPO_ADAPTER))
import witness  # noqa: E402
import witness_pygame as wp  # noqa: E402

wp.prepare()  # must run before pygame.init(): dummy video/audio drivers in witness mode
import pygame  # noqa: E402

W, H, FPS, SPEED, RATE = 320, 180, 60, 120.0, 22050
BACKGROUND, COIN, PLAYER = (20, 24, 40), (255, 210, 60), (80, 200, 255)

pygame.mixer.pre_init(frequency=RATE, size=-16, channels=1)
pygame.init()
screen = pygame.display.set_mode((W, H)) if witness.active() else None
canvas = pygame.Surface((W, H))  # the game always draws here; the window shows it scaled


def make_ding():
    n = int(RATE * 0.15)
    pcm = bytearray()
    for i in range(n):
        v = math.sin(2 * math.pi * 880 * i / RATE) * 0.5 * math.exp(-i / (RATE * 0.04))
        pcm += int(v * 32767).to_bytes(2, "little", signed=True)
    return pygame.mixer.Sound(buffer=bytes(pcm))


capture = witness.AudioCapture(RATE, channels=1)
bridge = wp.Bridge(canvas, capture)
ding = make_ding() if pygame.mixer.get_init() else None
state = {}


def reset(seed=1, scene=None, params=None):
    state.update(seed=seed, rng=random.Random(seed), score=0,
                 player={"id": 1, "type": "Player", "pos": [40.0, 90.0], "hp": 3},
                 coins=[{"id": 10 + i, "type": "Coin",
                         "pos": [80 + 40 * i, 90 if i == 0 else 60 + (seed * 7 + i * 13) % 61]}
                        for i in range(5)])
    if witness.active():
        bridge.reset()


def frame(dt):
    """One frame: handle events, update, draw. Called by the real-time loop or by Witness."""
    events = pygame.event.get()
    for e in events:
        if e.type == pygame.QUIT:
            raise SystemExit
        if e.type == pygame.KEYDOWN and e.key == pygame.K_F8:
            witness.mark("F8")
    keys = pygame.key.get_pressed()
    dx = (keys[pygame.K_RIGHT] or keys[pygame.K_d]) - (keys[pygame.K_LEFT] or keys[pygame.K_a])
    dy = (keys[pygame.K_DOWN] or keys[pygame.K_s]) - (keys[pygame.K_UP] or keys[pygame.K_w])
    pos = state["player"]["pos"]
    pos[0] = max(0.0, min(W, pos[0] + dx * SPEED * dt))
    pos[1] = max(0.0, min(H, pos[1] + dy * SPEED * dt))
    for coin in list(state["coins"]):
        if math.hypot(coin["pos"][0] - pos[0], coin["pos"][1] - pos[1]) < 12:
            state["coins"].remove(coin)
            state["score"] += 1
            witness.info("coin %d collected" % coin["id"])
            if ding is not None:
                bridge.play(ding)
    draw()
    if witness.recording():  # normal play with WITNESS_RECORD set: one replay line per frame
        recorded = (wp.event_to_witness(e) for e in events if e.type != pygame.MOUSEMOTION)
        witness.record_frame(dt, [r for r in recorded if r and r.get("key") != "f8"])


def draw():
    canvas.fill(BACKGROUND)
    for coin in state["coins"]:
        pygame.draw.circle(canvas, COIN, (round(coin["pos"][0]), round(coin["pos"][1])), 5)
    p = state["player"]["pos"]
    pygame.draw.circle(canvas, PLAYER, (round(p[0]), round(p[1])), 7)


def snapshot():
    return {"score": state["score"], "scene": "level1", "player": state["player"],
            "entities": [state["player"]] + state["coins"]}


def teleport(x, y):
    """move the player"""
    state["player"]["pos"] = [float(x), float(y)]
    return state["player"]["pos"]


def addcoin(x, y):
    """add a coin, returns the coin count"""
    state["coins"].append({"id": 100 + len(state["coins"]), "type": "Coin", "pos": [float(x), float(y)]})
    return len(state["coins"])


def play_realtime(scale=3):
    window = pygame.display.set_mode((W * scale, H * scale))
    pygame.display.set_caption("Coins (pygame) - arrows/WASD, F8 marks a replay moment")
    rec = witness.start_recording("Coins (pygame)", FPS)
    reset(witness.seed() if rec["path"] else random.randrange(1, 1000))
    clock = pygame.time.Clock()
    font = pygame.font.Font(None, 24)
    dt = 1.0 / FPS
    while True:
        frame(dt)
        window.blit(pygame.transform.scale(canvas, window.get_size()), (0, 0))
        window.blit(font.render("score %d%s" % (state["score"], "   REC" if rec["path"] else ""),
                                True, (255, 255, 255)), (8, 8))
        pygame.display.flip()
        dt = min(clock.tick(FPS) / 1000.0, 0.1)


def main():
    reset(1)
    if witness.active():
        witness.run(name="Coins (pygame)", fps=FPS, size=(W, H),
                    engine="pygame %s" % pygame.version.ver, reset=reset, on_input=bridge.inject,
                    update=frame, snapshot=snapshot, screenshot=bridge.screenshot, audio=capture,
                    calls={"teleport": teleport, "addcoin": addcoin},
                    keys=["left", "right", "up", "down", "w", "a", "s", "d"])
    else:
        play_realtime()
    pygame.quit()


if __name__ == "__main__":
    main()
