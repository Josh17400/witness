"""Optional pygame / pygame-ce helpers for the Witness Python adapter.

    import witness, witness_pygame as wp
    wp.prepare()                       # BEFORE pygame.init(): headless drivers in witness mode
    pygame.init()
    ...
    if witness.active():
        bridge = wp.Bridge(screen, capture)        # capture = witness.AudioCapture(...)
        witness.run(..., on_input=bridge.inject, update=frame, screenshot=bridge.screenshot,
                    audio=capture)

Nothing here touches pygame until you call it, and `prepare()` / `Bridge.install()` do
nothing outside witness mode.
"""

import os
from array import array

import witness

# Witness key names whose pygame name differs (everything else maps through pygame.key.key_code).
_SPECIAL = {"enter": "return", "ctrl": "left ctrl", "shift": "left shift", "alt": "left alt",
            "escape": "escape", "space": "space", "backspace": "backspace", "tab": "tab",
            "left": "left", "right": "right", "up": "up", "down": "down"}
_MOD_KEYS = {"ctrl": "KMOD_LCTRL", "shift": "KMOD_LSHIFT", "alt": "KMOD_LALT"}


def prepare(headless=True):
    """Call before pygame.init(). In witness mode selects SDL's dummy video/audio drivers so no
    window opens and the mixer never touches a real device (screenshots still work: you render
    into ordinary Surfaces). Pass headless=False to keep a visible window while debugging."""
    if witness.active() and headless:
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
        os.environ.setdefault("SDL_AUDIODRIVER", "dummy")


def key_code(name):
    """Witness key name -> pygame key constant (raises ValueError for unknown names)."""
    import pygame
    return pygame.key.key_code(_SPECIAL.get(name, name))


_REVERSE = {v: k for k, v in _SPECIAL.items()}
_REVERSE.update({"right ctrl": "ctrl", "right shift": "shift", "right alt": "alt"})


def key_name(code):
    """pygame key constant -> Witness key name (for recording replays during normal play)."""
    import pygame
    name = pygame.key.name(code).lower()
    return _REVERSE.get(name, name)


_FINGER_SLOTS = {}   # (touch_id, finger_id) -> small Witness finger id, while the finger is down


def _finger_slot(key, allocate):
    slot = _FINGER_SLOTS.get(key)
    if slot is None and allocate:
        used = set(_FINGER_SLOTS.values())
        slot = next(i for i in range(len(used) + 1) if i not in used)   # lowest free: 0 = first finger
        _FINGER_SLOTS[key] = slot
    return slot


def _finger_phases():
    import pygame
    return {getattr(pygame, "FINGERDOWN", -1): "down", getattr(pygame, "FINGERMOTION", -2): "move",
            getattr(pygame, "FINGERUP", -3): "up"}


def event_to_witness(e, size=None):
    """A real pygame event -> a protocol input event (or None), for witness.record_frame().

    FINGERDOWN/MOTION/UP become touch events in logical pixels (pygame's 0..1 coordinates times
    `size`, default the display surface's size) with small finger ids (0 = first finger down).
    Mouse events pygame synthesizes from a finger (`event.touch`) return None: replay recreates
    them from the touch through the mouse fallback."""
    import pygame
    phase = _finger_phases().get(e.type)
    if phase is not None:
        key = (getattr(e, "touch_id", 0), e.finger_id)
        slot = _finger_slot(key, phase != "up")
        if slot is None:
            return None   # lifted a finger that went down before recording started
        if phase == "up":
            _FINGER_SLOTS.pop(key, None)
        if size is None:
            surf = pygame.display.get_surface()
            size = surf.get_size() if surf is not None else (1, 1)
        out = {"type": "touch", "id": slot, "x": e.x * size[0], "y": e.y * size[1], "phase": phase}
        p = getattr(e, "pressure", None)
        if p is not None and 0 < p != 1:
            out["pressure"] = p
        return out
    if e.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP, pygame.MOUSEMOTION) and getattr(e, "touch", False):
        return None
    if e.type in (pygame.KEYDOWN, pygame.KEYUP):
        return {"type": "key", "key": key_name(e.key), "down": e.type == pygame.KEYDOWN}
    if e.type in (pygame.MOUSEBUTTONDOWN, pygame.MOUSEBUTTONUP) and e.button in (1, 2, 3):
        return {"type": "mouse", "x": e.pos[0], "y": e.pos[1], "button": e.button - 1,
                "down": e.type == pygame.MOUSEBUTTONDOWN}
    if e.type == pygame.MOUSEMOTION:
        return {"type": "mouse", "x": e.pos[0], "y": e.pos[1]}
    if e.type == pygame.MOUSEWHEEL:
        return {"type": "wheel", "dy": -e.y * 100}
    if e.type == pygame.TEXTINPUT:
        return {"type": "text", "text": e.text}
    return None


class _Pressed:
    """Stand-in for pygame.key.get_pressed()'s result: index it with a K_* constant."""

    __slots__ = ("codes",)

    def __init__(self, codes):
        self.codes = codes

    def __getitem__(self, code):
        return code in self.codes

    def __len__(self):
        return 512


class FixedClock:
    """Drop-in for pygame.time.Clock in witness mode: tick() never sleeps and reports a fixed dt."""

    def __init__(self, fps=60):
        self.fps = fps

    def tick(self, framerate=0):
        return int(round(1000.0 / self.fps))

    tick_busy_loop = tick

    def get_time(self):
        return int(round(1000.0 / self.fps))

    get_rawtime = get_time

    def get_fps(self):
        return float(self.fps)


class Bridge:
    """Routes Witness input through pygame's own event queue and exposes screenshots/audio.

    * inject(event)   posts KEYDOWN/KEYUP/MOUSE*/TEXTINPUT/FINGER* events with pygame.event.post, so
                      the game's normal `for e in pygame.event.get()` loop sees them. Touch becomes
                      FINGERDOWN/FINGERMOTION/FINGERUP ("cancel" also posts FINGERUP: pygame has no
                      cancel event) with pygame's normalized 0..1 x/y/dx/dy (the
                      pixel coordinates divided by `size`: Bridge(size=...), else the hello size,
                      else the surface's size); finger 0's mouse fallback arrives as MOUSE* events
                      with touch=True, like pygame's own mouse-from-touch events.
    * install()       (called by the constructor in witness mode) patches pygame.key.get_pressed,
                      pygame.key.get_mods, pygame.mouse.get_pos/get_pressed and
                      pygame.time.get_ticks so polled input and timers follow simulated time.
    * screenshot()    RGBA bytes of the given surface (default: the display surface).
    * play(sound)     witness mode: mixes the Sound's samples into the AudioCapture;
                      otherwise: sound.play().
    """

    def __init__(self, surface=None, capture=None, install=True, size=None):
        self.surface = surface
        self.capture = capture
        self.size = tuple(size) if size else None   # logical size touch coordinates are normalized by
        self.codes = set()       # pygame key codes held
        self.buttons = [False, False, False]
        self.mouse = (0, 0)
        self.fingers = {}        # Witness finger id -> last (x, y) in pixels, while down
        self._orig = {}
        if install and witness.active():
            self.install()

    def logical_size(self):
        """(w, h) that touch pixel coordinates are divided by for pygame's normalized 0..1 values."""
        size = self.size or getattr(witness._A, "size", None)
        if not size:
            import pygame
            surf = self.surface or pygame.display.get_surface()
            size = surf.get_size() if surf is not None else (1, 1)
        return max(1, size[0]), max(1, size[1])

    # ------------------------------------------------------------------ input
    def inject(self, ev):
        import pygame
        t = ev.get("type")
        if t == "key":
            try:
                code = key_code(ev["key"])
            except ValueError:
                witness.warn("witness_pygame: no pygame key for '%s'" % ev.get("key"))
                return
            down = bool(ev.get("down"))
            (self.codes.add if down else self.codes.discard)(code)
            name = ev["key"]
            uni = name if len(name) == 1 else (" " if name == "space" else "")
            pygame.event.post(pygame.event.Event(pygame.KEYDOWN if down else pygame.KEYUP,
                                                 key=code, mod=self.mods(), unicode=uni if down else "",
                                                 scancode=0))
        elif t == "mouse":
            touch = bool(ev.get("from_touch"))   # the mouse fallback of finger 0 (pygame's event.touch)
            pos = (int(ev.get("x", self.mouse[0])), int(ev.get("y", self.mouse[1])))
            if pos != self.mouse:
                rel = (pos[0] - self.mouse[0], pos[1] - self.mouse[1])
                self.mouse = pos
                pygame.event.post(pygame.event.Event(pygame.MOUSEMOTION, pos=pos, rel=rel,
                                                     buttons=tuple(int(b) for b in self.buttons), touch=touch))
            if "down" in ev:
                b = int(ev.get("button", 0))
                if 0 <= b <= 2:
                    self.buttons[b] = bool(ev["down"])
                kind = pygame.MOUSEBUTTONDOWN if ev["down"] else pygame.MOUSEBUTTONUP
                pygame.event.post(pygame.event.Event(kind, pos=pos, button=b + 1, touch=touch))
        elif t == "touch":
            phase = ev.get("phase", "move")
            # pygame has no finger-cancel event: "cancel" (the system ended the touch) arrives as FINGERUP
            kind = {"down": pygame.FINGERDOWN, "up": pygame.FINGERUP,
                    "cancel": pygame.FINGERUP}.get(phase, pygame.FINGERMOTION)
            fid = int(ev.get("id", 0) or 0)
            x, y = float(ev.get("x", 0)), float(ev.get("y", 0))
            px, py = (x, y) if phase == "down" else self.fingers.get(fid, (x, y))
            if phase in ("up", "cancel"):
                self.fingers.pop(fid, None)
            else:
                self.fingers[fid] = (x, y)
            w, h = self.logical_size()
            pygame.event.post(pygame.event.Event(kind, touch_id=0, finger_id=fid, x=x / w, y=y / h,
                                                 dx=(x - px) / w, dy=(y - py) / h,
                                                 pressure=float(ev.get("pressure", 1.0))))
        elif t == "wheel":
            pygame.event.post(pygame.event.Event(pygame.MOUSEWHEEL, x=0, y=-int(round(ev.get("dy", 0) / 100)),
                                                 flipped=False))
        elif t == "text":
            pygame.event.post(pygame.event.Event(pygame.TEXTINPUT, text=str(ev.get("text", ""))))

    def mods(self):
        import pygame
        m = 0
        for name, attr in _MOD_KEYS.items():
            if key_code(name) in self.codes:
                m |= getattr(pygame, attr)
        return m

    def install(self):
        """Patch pygame's polling functions to read injected state (witness mode only)."""
        import pygame
        if self._orig:
            return
        self._orig = {"get_pressed": pygame.key.get_pressed, "get_mods": pygame.key.get_mods,
                      "get_pos": pygame.mouse.get_pos, "mouse_pressed": pygame.mouse.get_pressed,
                      "get_ticks": pygame.time.get_ticks}
        pygame.key.get_pressed = lambda: _Pressed(self.codes)
        pygame.key.get_mods = self.mods
        pygame.mouse.get_pos = lambda: self.mouse
        pygame.mouse.get_pressed = lambda num_buttons=3: tuple(self.buttons) + (False,) * (num_buttons - 3)
        pygame.time.get_ticks = lambda: int(witness.time() * 1000)

    def uninstall(self):
        import pygame
        if not self._orig:
            return
        pygame.key.get_pressed = self._orig["get_pressed"]
        pygame.key.get_mods = self._orig["get_mods"]
        pygame.mouse.get_pos = self._orig["get_pos"]
        pygame.mouse.get_pressed = self._orig["mouse_pressed"]
        pygame.time.get_ticks = self._orig["get_ticks"]
        self._orig = {}

    def reset(self):
        """Forget held keys/buttons and queued pygame events (call from the game's reset)."""
        import pygame
        self.codes.clear()
        self.buttons = [False, False, False]
        self.mouse = (0, 0)
        self.fingers = {}
        pygame.event.clear()

    # ------------------------------------------------------------------ screenshots
    def screenshot(self, scale=None):
        import pygame
        surf = self.surface or pygame.display.get_surface()
        if surf is None:
            raise witness.WitnessError("no surface to capture (pass one to Bridge or set a display mode)")
        if scale and scale != 1:
            size = (max(1, int(surf.get_width() * scale)), max(1, int(surf.get_height() * scale)))
            surf = pygame.transform.smoothscale(surf.convert_alpha() if surf.get_bitsize() != 32 else surf, size)
        to_bytes = getattr(pygame.image, "tobytes", None) or pygame.image.tostring
        return surf.get_width(), surf.get_height(), to_bytes(surf, "RGBA")

    # ------------------------------------------------------------------ audio
    def play(self, sound, volume=1.0):
        """Play a pygame.mixer.Sound: into the capture in witness mode, to the speakers otherwise."""
        if self.capture is None or not witness.active():
            channel = sound.play()
            if channel is not None and volume != 1.0:
                channel.set_volume(volume)
            return channel
        import pygame
        init = pygame.mixer.get_init()
        if not init:
            raise witness.WitnessError("pygame.mixer is not initialized")
        freq, size, channels = init[0], init[1], init[2]
        if freq != self.capture.sample_rate:
            raise witness.WitnessError("mixer runs at %d Hz but the capture at %d Hz: init the mixer with "
                                       "frequency=%d" % (freq, self.capture.sample_rate, self.capture.sample_rate))
        gain = volume * sound.get_volume()
        raw = sound.get_raw()
        if size == -16:
            self.capture.play_pcm16(raw, channels=channels, gain=gain)
        elif size == 32:
            pcm = array("f")
            pcm.frombytes(raw[: len(raw) - len(raw) % 4])
            if channels != self.capture.channels:
                raise witness.WitnessError("float mixer: use the same channel count as the capture")
            self.capture.play(pcm, gain)
        else:
            raise witness.WitnessError("init pygame.mixer with size=-16 or 32 for capture (got %r)" % size)
        return None
