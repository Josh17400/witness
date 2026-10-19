"""Coins: the standard Witness sample game in plain Python (stdlib only).

    python coins.py                       play it in a tkinter window (arrows/WASD, F8 = replay mark)
    WITNESS_RECORD=replay.jsonl python coins.py   ...and record a replay for `witness replay`
    python coins.py --demo                a scripted 2 s real-time session (no window; records too)
    witness doctor / witness test         drive it headlessly through the Witness adapter

The game logic is engine-free: `Coins.update(dt)` advances one frame from the keys held,
`Coins.render()` rasterizes the frame into RGBA bytes, and every sound is mixed into a
`witness.AudioCapture`. Witness mode and real-time mode share all of it.
"""

import math
import os
import random
import sys

# Inside the Witness repo the adapter lives in adapters/python/. A real game simply ships
# witness.py next to its main script (`witness init` puts it there).
_REPO_ADAPTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "adapters", "python")
if os.path.isfile(os.path.join(_REPO_ADAPTER, "witness.py")):
    sys.path.insert(0, os.path.normpath(_REPO_ADAPTER))
import witness  # noqa: E402

W, H, FPS, SPEED, SAMPLE_RATE = 320, 180, 60, 120.0, 22050
BACKGROUND, COIN, PLAYER = (20, 24, 40), (255, 210, 60), (80, 200, 255)


def make_ding(sample_rate=SAMPLE_RATE):
    """0.15 s, 880 Hz, exponentially decaying sine."""
    n = int(sample_rate * 0.15)
    return [math.sin(2 * math.pi * 880 * i / sample_rate) * 0.5 * math.exp(-i / (sample_rate * 0.04))
            for i in range(n)]


class Coins:
    def __init__(self):
        self.audio = witness.AudioCapture(SAMPLE_RATE, channels=1)
        self.ding = make_ding()
        self.reset(1)

    # ------------------------------------------------------------------ simulation
    def reset(self, seed=1, scene=None, params=None):
        self.seed = seed
        self.rng = random.Random(seed)  # every random choice in the game comes from here
        self.keys = set()
        self.score = 0
        self.player = {"id": 1, "type": "Player", "pos": [40.0, 90.0], "hp": 3}
        self.coins = [{"id": 10 + i, "type": "Coin",
                       "pos": [80 + 40 * i, 90 if i == 0 else 60 + (seed * 7 + i * 13) % 61]}
                      for i in range(5)]
        self.audio.reset()

    def on_input(self, event):
        if event.get("type") == "key":
            (self.keys.add if event.get("down") else self.keys.discard)(event["key"])
        elif event.get("type") == "action" and event.get("action") == "dash":
            self.player["pos"][0] += 30

    def held(self, *names):
        return any(n in self.keys for n in names)

    def update(self, dt):
        dx = self.held("right", "d") - self.held("left", "a")
        dy = self.held("down", "s") - self.held("up", "w")
        pos = self.player["pos"]
        pos[0] = max(0.0, min(W, pos[0] + dx * SPEED * dt))
        pos[1] = max(0.0, min(H, pos[1] + dy * SPEED * dt))
        for coin in list(self.coins):
            if math.hypot(coin["pos"][0] - pos[0], coin["pos"][1] - pos[1]) < 12:
                self.coins.remove(coin)
                self.score += 1
                witness.info("coin %d collected" % coin["id"])
                self.audio.play(self.ding)
                witness.sound("coin")  # named in witness listen (docs/PROTOCOL.md: sound events)

    def snapshot(self):
        return {"score": self.score, "scene": "level1", "player": self.player,
                "entities": [self.player] + self.coins}

    # ------------------------------------------------------------------ calls
    def teleport(self, x, y):
        """move the player"""
        self.player["pos"] = [float(x), float(y)]
        return self.player["pos"]

    def addcoin(self, x, y):
        """add a coin, returns the coin count"""
        self.coins.append({"id": 100 + len(self.coins), "type": "Coin", "pos": [float(x), float(y)]})
        return len(self.coins)

    # ------------------------------------------------------------------ rendering
    def render(self):
        """The frame as (width, height, RGBA bytes), top row first."""
        px = bytearray(bytes((*BACKGROUND, 255)) * (W * H))

        def blob(p, r, color):
            cx, cy = int(round(p[0])), int(round(p[1]))
            rgba = bytes((*color, 255))
            for y in range(max(0, cy - r), min(H - 1, cy + r) + 1):
                half = int(math.isqrt(r * r - (y - cy) * (y - cy)))
                x0, x1 = max(0, cx - half), min(W - 1, cx + half)
                if x0 <= x1:
                    i = (y * W + x0) * 4
                    px[i:i + (x1 - x0 + 1) * 4] = rgba * (x1 - x0 + 1)

        for coin in self.coins:
            blob(coin["pos"], 5, COIN)
        blob(self.player["pos"], 7, PLAYER)
        return W, H, bytes(px)


# ---------------------------------------------------------------------- real-time mode (tkinter)

TK_KEYS = {"Return": "enter", "Escape": "escape", "Left": "left", "Right": "right", "Up": "up",
           "Down": "down", "Shift_L": "shift", "Shift_R": "shift", "Control_L": "ctrl",
           "Control_R": "ctrl", "Alt_L": "alt", "Alt_R": "alt", "BackSpace": "backspace", "Tab": "tab"}


def witness_key(keysym):
    return TK_KEYS.get(keysym, keysym.lower())


def play_realtime(game, scale=3):
    import time
    import tkinter as tk

    rec = witness.start_recording("Coins (Python)", FPS)
    game.reset(witness.seed() if witness.recording() else random.randrange(1, 1000))
    root = tk.Tk()
    root.title("Coins - arrows/WASD to move, F8 marks a replay moment")
    canvas = tk.Canvas(root, width=W * scale, height=H * scale, highlightthickness=0)
    canvas.pack()
    pending = []  # input events since the last frame (for the replay)

    def key(event, down):
        name = witness_key(event.keysym)
        if name == "f8" and down:
            witness.mark("F8")
            return
        if (name in game.keys) == down:
            return  # ignore OS auto-repeat
        e = {"type": "key", "key": name, "down": down}
        pending.append(e)
        game.on_input(e)

    root.bind("<KeyPress>", lambda e: key(e, True))
    root.bind("<KeyRelease>", lambda e: key(e, False))
    last = [time.perf_counter() - 1.0 / FPS]  # the first frame gets a normal dt

    def tick():
        now = time.perf_counter()
        dt, last[0] = min(now - last[0], 0.1), now
        game.update(dt)
        witness.record_frame(dt, pending[:])
        pending.clear()
        canvas.delete("all")
        canvas.configure(bg="#%02x%02x%02x" % BACKGROUND)
        for coin in game.coins:
            x, y = coin["pos"]
            canvas.create_oval((x - 5) * scale, (y - 5) * scale, (x + 5) * scale, (y + 5) * scale,
                               fill="#%02x%02x%02x" % COIN, outline="")
        x, y = game.player["pos"]
        canvas.create_oval((x - 7) * scale, (y - 7) * scale, (x + 7) * scale, (y + 7) * scale,
                           fill="#%02x%02x%02x" % PLAYER, outline="")
        canvas.create_text(8, 8, anchor="nw", fill="white", font=("Segoe UI", 12),
                           text="score %d%s" % (game.score, "   REC" if rec["path"] else ""))
        root.after(max(1, int(1000 / FPS - (time.perf_counter() - now) * 1000)), tick)

    tick()
    root.mainloop()


def demo(game, seconds=2.0):
    """Normal (real-time) play driven by a scripted "player": hold right from 0 s to 1.2 s and
    press F8 at 0.5 s. Real, irregular frame times, so `witness replay` has something to prove."""
    import time

    witness.start_recording("Coins (Python)", FPS)
    game.reset(witness.seed())
    t, holding, marked, last = 0.0, False, False, time.perf_counter()
    while t < seconds:
        time.sleep(1.0 / FPS)
        now = time.perf_counter()
        dt, last = now - last, now
        events = []
        if not holding and t < 1.2:
            holding = True
            events.append({"type": "key", "key": "right", "down": True})
        elif holding and t >= 1.2:
            holding = False
            events.append({"type": "key", "key": "right", "down": False})
        if not marked and t >= 0.5:
            marked = True
            witness.mark("F8")
        for e in events:
            game.on_input(e)
        game.update(dt)
        witness.record_frame(dt, events)
        t += dt
    x, y = game.player["pos"]
    print("demo finished: t=%.3fs seed=%d score=%d player=(%.4f, %.4f) coins=%d"
          % (t, game.seed, game.score, x, y, len(game.coins)))


def main():
    game = Coins()
    if witness.active():
        witness.run(
            name="Coins (Python)", fps=FPS, size=(W, H), engine="python stdlib",
            reset=game.reset, on_input=game.on_input, update=game.update,
            snapshot=game.snapshot, screenshot=game.render, audio=game.audio,
            calls={"teleport": game.teleport, "addcoin": game.addcoin},
            namespace=lambda: {"game": game, "witness": witness, "math": math},
            keys=["left", "right", "up", "down", "w", "a", "s", "d"],
        )
    elif "--demo" in sys.argv:
        demo(game)
    else:
        play_realtime(game)


if __name__ == "__main__":
    main()
