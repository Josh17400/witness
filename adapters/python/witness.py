"""Witness adapter for Python games (protocol v1, stdlib only, Python 3.8+).

Witness lets an outside tool (the `witness` CLI) drive a game deterministically: reset it
with a seed, feed it input on exact frames, step it at a fixed dt, and read back its state,
screenshots, audio and logs. See docs/PROTOCOL.md in the Witness repo.

Typical use, in the game's entry point::

    import witness

    if witness.active():                    # WITNESS_ADDR set, or --witness passed
        witness.run(name="My Game", fps=60, size=(640, 360),
                    reset=game.reset,        # (seed[, scene[, params]])
                    on_input=game.on_input,  # (event dict) at the start of the event's frame
                    update=game.update,      # (dt) one fixed frame
                    snapshot=game.snapshot,  # () -> JSON-able dict
                    screenshot=game.rgba,    # () -> (width, height, rgba bytes)
                    audio=game.capture,      # a witness.AudioCapture
                    calls={"teleport": game.teleport})
    else:
        game.run_realtime()

When the game is not in witness mode nothing here runs: importing the module opens no
socket and starts no thread, and every helper returns immediately.
"""

import base64
import enum
import inspect
import json
import math
import os
import socket
import sys
import time as _time
import traceback
from array import array

__all__ = [
    "PROTOCOL", "DEFAULT_ADDR", "active", "recording", "address", "run", "seed", "frame", "time",
    "log", "info", "warn", "error", "input_events", "is_down", "record_frame", "record_event",
    "record_touch", "mark", "start_recording", "AudioCapture", "json_safe", "WitnessError",
    "watching",
]

PROTOCOL = 1
DEFAULT_ADDR = "127.0.0.1:7357"
_LEVELS = ("info", "warn", "error")
_PHASES = ("down", "move", "up")
_BIG_ENDIAN = sys.byteorder == "big"


class WitnessError(Exception):
    """Raised for adapter misuse (bad arguments, connecting twice, unreachable CLI)."""


# Fallback for run(idle=...): called repeatedly while waiting for the next command. Kept for
# compatibility with older glue code; prefer passing idle= to run().
IDLE = None


# ---------------------------------------------------------------------------- mode detection

def active():
    """True when the game should run in witness mode (WITNESS_ADDR is set or --witness was passed)."""
    return bool(os.environ.get("WITNESS_ADDR")) or "--witness" in sys.argv


def watching():
    """True when witness mode is active AND WITNESS_WATCH=1 (`witness play start --watch`).

    A watched game shows its window, presents a frame every step (or every 2nd step), drops the
    viewer's real input (only Witness-injected input reaches it) and passes idle= to run() so its
    window stays responsive between commands. It must NOT pace itself: the CLI paces to real time.
    """
    return active() and os.environ.get("WITNESS_WATCH") == "1"


def recording():
    """True when a human is playing normally and WITNESS_RECORD=<file.jsonl> asks for a replay."""
    return bool(os.environ.get("WITNESS_RECORD")) and not active()


def address():
    """(host, port) the adapter connects to."""
    addr = os.environ.get("WITNESS_ADDR") or DEFAULT_ADDR
    host, _, port = addr.rpartition(":")
    try:
        return (host or "127.0.0.1"), int(port)
    except ValueError:
        raise WitnessError("WITNESS_ADDR must look like 127.0.0.1:7357, got %r" % addr) from None


# ---------------------------------------------------------------------------- JSON safety

def json_safe(value, _depth=0):
    """Convert `value` into something json.dumps accepts and JavaScript can parse.

    NaN/inf become the strings "NaN"/"Infinity"/"-Infinity", tuples and sets become lists,
    dict keys become strings, dataclasses/namedtuples/objects with a `witness_state()` method
    or a `__dict__` become dicts, bytes become base64 and anything else becomes its repr.
    """
    if _depth > 64:
        return "<max depth>"
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    d = _depth + 1
    if isinstance(value, dict):
        return {k if isinstance(k, str) else str(k): json_safe(v, d) for k, v in value.items()}
    if isinstance(value, tuple) and hasattr(value, "_asdict"):
        return json_safe(value._asdict(), d)
    if isinstance(value, (list, tuple)):
        return [json_safe(v, d) for v in value]
    if isinstance(value, (set, frozenset)):
        items = [json_safe(v, d) for v in value]
        try:
            return sorted(items)  # stable order, so snapshots stay byte-identical
        except TypeError:
            return sorted(items, key=repr)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    state = getattr(value, "witness_state", None)
    if callable(state):
        return json_safe(state(), d)
    if hasattr(value, "__dataclass_fields__"):
        return {f: json_safe(getattr(value, f), d) for f in value.__dataclass_fields__}
    if isinstance(value, enum.Enum):
        return json_safe(value.value, d)
    if hasattr(value, "tolist"):  # numpy arrays/scalars, array.array
        return json_safe(value.tolist(), d)
    if hasattr(value, "__dict__"):
        return {k: json_safe(v, d) for k, v in vars(value).items() if not k.startswith("_")}
    if hasattr(value, "__iter__"):
        try:
            return [json_safe(v, d) for v in value]
        except TypeError:
            pass
    return repr(value)


def _dumps(obj):
    """One protocol line. Fast path for plain data, json_safe() only when needed."""
    try:
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        return json.dumps(json_safe(obj), separators=(",", ":"), ensure_ascii=False, allow_nan=False)


# ---------------------------------------------------------------------------- audio capture

class AudioCapture:
    """A float PCM buffer that advances with simulated time.

    The game mixes every sound it would play into this buffer with :meth:`play` (at the
    current simulated time), the adapter calls :meth:`advance` after every frame, and the
    `audio` command returns exactly the samples between the previous call and now.
    Sounds that run past "now" stay buffered and come out on the next call.
    """

    def __init__(self, sample_rate=22050, channels=1):
        if sample_rate <= 0 or channels not in (1, 2):
            raise WitnessError("AudioCapture needs sample_rate > 0 and 1 or 2 channels")
        self.sample_rate = int(sample_rate)
        self.channels = int(channels)
        self.reset()

    def reset(self):
        """Drop everything and rewind to t = 0 (the adapter calls this on `reset`)."""
        self._buf = array("f")   # interleaved samples starting at frame self._base
        self._base = 0           # absolute sample frame of self._buf[0]
        self._time = 0.0         # simulated seconds
        self._cursor = 0         # absolute sample frame of "now"

    @property
    def cursor(self):
        """The absolute sample frame that corresponds to the current simulated time."""
        return self._cursor

    def _ensure(self, frames_from_base):
        missing = frames_from_base * self.channels - len(self._buf)
        if missing > 0:
            self._buf.frombytes(bytes(4 * missing))  # zero-filled floats

    def play(self, samples, gain=1.0, offset=0.0):
        """Mix interleaved float samples (-1..1, this capture's channel count) starting now.

        `offset` delays the sound by that many seconds of simulated time.
        """
        start = self._cursor + int(round(offset * self.sample_rate)) - self._base
        if start < 0:
            samples = samples[-start * self.channels:]
            start = 0
        n = len(samples) // self.channels
        if n <= 0:
            return
        self._ensure(start + n)
        buf, i0 = self._buf, start * self.channels
        if gain == 1.0:
            for i, s in enumerate(samples):
                buf[i0 + i] += s
        else:
            for i, s in enumerate(samples):
                buf[i0 + i] += s * gain

    def play_pcm16(self, data, channels=None, gain=1.0, offset=0.0):
        """Mix raw signed 16-bit little-endian PCM (e.g. pygame Sound.get_raw()).

        `channels` is the channel count of `data` (default: this capture's). Mono is copied
        to both channels and stereo is averaged down to mono as needed. The sample rate must
        already match (initialize your mixer at the capture's rate).
        """
        pcm = array("h")
        pcm.frombytes(bytes(data[: len(data) - len(data) % 2]))
        if _BIG_ENDIAN:
            pcm.byteswap()
        src = channels or self.channels
        scale = gain / 32768.0
        if src == self.channels:
            floats = [s * scale for s in pcm]
        elif src == 2 and self.channels == 1:
            floats = [(pcm[i] + pcm[i + 1]) * 0.5 * scale for i in range(0, len(pcm) - 1, 2)]
        elif src == 1 and self.channels == 2:
            floats = [v for s in pcm for v in (s * scale, s * scale)]
        else:
            raise WitnessError("play_pcm16 supports 1 or 2 channels, got %r" % src)
        self.play(floats, 1.0, offset)

    def advance(self, dt):
        """Move "now" forward by dt simulated seconds (rounded on the absolute clock, so no drift)."""
        self._time += dt
        self._cursor = int(round(self._time * self.sample_rate))
        self._ensure(self._cursor - self._base)

    def take(self):
        """The `audio` command result: everything mixed between the previous take and now."""
        n = (self._cursor - self._base) * self.channels
        out = self._buf[:n]
        del self._buf[:n]
        self._base = self._cursor
        for i, s in enumerate(out):  # hard clip like a real output device would
            if s > 1.0:
                out[i] = 1.0
            elif s < -1.0:
                out[i] = -1.0
        if _BIG_ENDIAN:
            out.byteswap()
        return {"sampleRate": self.sample_rate, "channels": self.channels, "format": "f32",
                "data": base64.b64encode(out.tobytes()).decode("ascii")}


# ---------------------------------------------------------------------------- the adapter

def _arity(fn):
    """How many positional arguments `fn` accepts (None = any number)."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return None
    n = 0
    for p in params:
        if p.kind == p.VAR_POSITIONAL:
            return None
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
            n += 1
    return n


def _call_flex(fn, *args):
    """Call fn with as many of `args` as it accepts, so handlers can take fewer parameters."""
    n = _arity(fn)
    return fn(*(args if n is None else args[:n]))


def _describe_call(name, fn):
    entry = {"name": name}
    try:
        params = [p.name for p in inspect.signature(fn).parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)]
        if params:
            entry["args"] = " ".join(params)
    except (TypeError, ValueError):
        pass
    doc = inspect.getdoc(fn)
    if doc:
        entry["help"] = doc.strip().splitlines()[0]
    return entry


_THIS_FILE = os.path.normcase(os.path.abspath(__file__))


def _game_traceback(exc):
    """'Type: message' plus the game's own stack frames (adapter frames dropped)."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__)
              if os.path.normcase(os.path.abspath(f.filename)) != _THIS_FILE]
    where = "".join(traceback.format_list(frames[-6:])).rstrip()
    return "%s: %s%s" % (type(exc).__name__, exc, ("\n" + where) if where else "")


def _num(v, default):
    try:
        return float(v) if v is not None and not isinstance(v, bool) else default
    except (TypeError, ValueError):
        return default


def _touch(e):
    """A protocol touch event with its fields defaulted: id 0, x/y floats, phase "move", pressure 1."""
    e = dict(e)
    e["id"] = int(_num(e.get("id"), 0))
    e["x"] = _num(e.get("x"), 0.0)
    e["y"] = _num(e.get("y"), 0.0)
    if e.get("phase") not in _PHASES:
        e["phase"] = "move"
    e["pressure"] = _num(e.get("pressure"), 1.0)
    return e


def _mouse_from_touch(t):
    """The mouse fallback for finger 0: down -> button 0 down, move -> a move, up -> button 0 up."""
    m = {"frame": t.get("frame", 0), "type": "mouse", "x": t["x"], "y": t["y"], "from_touch": True}
    if t["phase"] != "move":
        m["button"] = 0
        m["down"] = t["phase"] == "down"
    return m


def _replay_event(e):
    """An event in replay shape (no "frame"); touch gets exactly id/x/y/phase (+ pressure if not 1)."""
    if e.get("type") != "touch":
        return {k: v for k, v in e.items() if k != "frame"}
    out = {"type": "touch", "id": int(_num(e.get("id"), 0)), "x": e.get("x", 0), "y": e.get("y", 0),
           "phase": e.get("phase") if e.get("phase") in _PHASES else "move"}
    p = _num(e.get("pressure"), 1.0)
    if 0 < p != 1:
        out["pressure"] = p
    return out


class _Adapter:
    def __init__(self):
        self.seed = None
        self.frame = 0
        self.time = 0.0
        self.queue = []          # pending input events (protocol dicts with "frame")
        self.due = []            # events applied at the current frame (input_events())
        self.down = set()        # key names currently held (is_down())
        self.logs = []
        self.connected = False
        self.perf = {"update_ms": 0.0, "render_ms": 0.0, "frame_ms": 0.0}
        self.recorder = None
        self.rec_pending = []    # record_event()/record_touch() events for the next record_frame()
        self.size = None         # the hello's logical size (touch helpers normalize by it)
        self.threaded = False    # commands are read on a background thread (run(idle=...))

    # -------------------------------------------------------------- logging
    def log(self, level, message):
        if not self.connected:
            return
        level = level if level in _LEVELS else ("warn" if level == "warning" else "info")
        self.logs.append({"frame": self.frame, "level": level, "message": str(message)})
        if len(self.logs) > 10000:
            del self.logs[: len(self.logs) - 10000]

    # -------------------------------------------------------------- connection
    def connect(self, hello, retries=20):
        host, port = address()
        last = None
        for attempt in range(retries):
            try:
                sock = socket.create_connection((host, port), timeout=5)
                break
            except OSError as e:  # CLI not listening yet (attach mode): retry briefly
                last = e
                _time.sleep(min(0.05 * (attempt + 1), 0.5))
        else:
            raise WitnessError("could not reach the Witness CLI at %s:%d (%s)" % (host, port, last))
        sock.settimeout(None)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        self.sock = sock
        self.reader = sock.makefile("rb")
        self.connected = True
        self.send({"hello": hello})

    def send(self, obj):
        self.sock.sendall((_dumps(obj) + "\n").encode("utf-8"))

    def close(self):
        if not self.connected:
            return
        self.connected = False
        closers = (self.reader.close, lambda: self.sock.shutdown(socket.SHUT_RDWR), self.sock.close)
        if self.threaded:  # unblock the reader thread's readline first (close() would wait on its lock)
            closers = (closers[1], closers[0], closers[2])
        for closer in closers:
            try:
                closer()
            except OSError:
                pass
        self.threaded = False

    # -------------------------------------------------------------- simulation
    def step_once(self, h, dt):
        f = self.frame
        due = [e for e in self.queue if e.get("frame", 0) <= f]
        if due:
            self.queue = [e for e in self.queue if e.get("frame", 0) > f]
            for e in due:
                if e.get("type") == "key" and "key" in e:
                    (self.down.add if e.get("down") else self.down.discard)(e["key"])
                if h["on_input"]:
                    h["on_input"](e)
        self.due = due
        if h["update"]:
            h["update"](dt)
        if h["audio"] is not None and hasattr(h["audio"], "advance"):
            h["audio"].advance(dt)
        self.frame = f + 1
        self.time += dt

    def do_reset(self, h, msg):
        self.seed = int(msg.get("seed", 1) or 0)
        self.frame, self.time = 0, 0.0
        self.queue, self.due, self.down = [], [], set()
        self.logs = []
        audio = h["audio"]
        if audio is not None and hasattr(audio, "reset"):
            audio.reset()
        if h["reset"]:
            _call_flex(h["reset"], self.seed, msg.get("scene"), msg.get("params") or {})
        return {}

    def do_step(self, h, msg):
        frames = int(msg.get("frames", 1))
        if frames < 1:
            raise WitnessError("step needs frames >= 1")
        dts = msg.get("dts")
        dt = float(msg.get("dt") or 1.0 / h["fps"])
        t0 = _time.perf_counter()
        for i in range(frames):
            self.step_once(h, float(dts[i]) if dts and i < len(dts) else dt)
        ms = (_time.perf_counter() - t0) * 1000.0 / frames
        self.perf["update_ms"] = self.perf["frame_ms"] = ms
        return {"frame": self.frame, "time": self.time}

    def do_screenshot(self, h, msg):
        t0 = _time.perf_counter()
        shot = _call_flex(h["screenshot"], msg.get("scale"))
        self.perf["render_ms"] = (_time.perf_counter() - t0) * 1000.0
        if isinstance(shot, dict):
            return shot
        width, height, pixels = shot
        pixels = bytes(pixels)
        if len(pixels) != width * height * 4:
            raise WitnessError("screenshot returned %d bytes, expected %dx%dx4 = %d"
                               % (len(pixels), width, height, width * height * 4))
        return {"width": width, "height": height, "format": "rgba8",
                "data": base64.b64encode(pixels).decode("ascii")}

    def do_input(self, h, msg):
        # finger 0 is also queued as the matching mouse event ("from_touch": True) right after
        # each touch, unless the game handles touch itself (run(touch=True))
        for e in msg.get("events") or []:
            if not isinstance(e, dict):
                continue
            if e.get("type") == "touch":
                e = _touch(e)
                self.queue.append(e)
                if e["id"] == 0 and not h.get("touch"):
                    self.queue.append(_mouse_from_touch(e))
            else:
                self.queue.append(e)
        return {}

    def do_audio(self, h, msg):
        audio = h["audio"]
        return audio.take() if hasattr(audio, "take") else audio()

    def do_call(self, h, msg):
        name = msg.get("name")
        fn = h["calls"].get(name)
        if fn is None:
            known = ", ".join(sorted(h["calls"])) or "none"
            raise WitnessError("unknown call '%s' (known: %s)" % (name, known))
        return {"result": fn(*(msg.get("args") or []))}

    def do_eval(self, h, msg):
        ns = h["namespace"]
        ns = ns() if callable(ns) else ns
        if ns is None:
            ns = vars(sys.modules["__main__"])
        expr = str(msg.get("expr", ""))
        try:
            code = compile(expr, "<witness eval>", "eval")
        except SyntaxError:
            exec(compile(expr, "<witness eval>", "exec"), ns)  # statements: run them, return null
            return {"value": None}
        return {"value": json_safe(eval(code, ns))}

    def do_perf(self, h, msg):
        out = {k: round(v, 4) for k, v in self.perf.items()}
        if h["perf"]:
            extra = h["perf"]()
            if isinstance(extra, dict):
                out.update(extra)
        return out

    def do_logs(self, h, msg):
        logs, self.logs = self.logs, []
        return {"logs": logs}

    # -------------------------------------------------------------- main loop
    def serve(self, h):
        handlers = {
            "reset": self.do_reset, "step": self.do_step,
            "snapshot": lambda h, m: {"frame": self.frame, "time": self.time,
                                      "state": json_safe(_call_flex(h["snapshot"], m.get("paths")))},
            "input": self.do_input,
            "screenshot": self.do_screenshot, "audio": self.do_audio, "call": self.do_call,
            "eval": self.do_eval, "logs": self.do_logs, "perf": self.do_perf,
        }
        available = set(h["capabilities"])
        next_line = self.reader.readline
        idle = h.get("idle")
        if idle is not None:
            next_line = self._threaded_reader(idle)
        while True:
            try:
                line = next_line()
            except OSError:
                break
            if not line:
                break  # the CLI went away
            line = line.strip()
            if line.startswith(b"@w"):
                line = line[2:]
            if not line:
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError as e:
                self.log("error", "witness: unreadable command (%s): %r" % (e, line[:200]))
                continue
            mid, cmd = msg.get("id"), msg.get("cmd")
            if cmd == "quit":
                self.send({"id": mid, "ok": True})
                break
            fn = handlers.get(cmd)
            if fn is None or (cmd not in available and cmd != "logs"):
                self.send({"id": mid, "ok": False, "error": "unknown or unsupported command '%s'" % cmd})
                continue
            try:
                result = fn(h, msg) or {}
                reply = {"id": mid, "ok": True}
                reply.update(result)
                self.send(reply)
            except Exception as e:  # report game errors to the CLI instead of crashing
                self.log("error", "%s failed: %s: %s" % (cmd, type(e).__name__, e))
                self.send({"id": mid, "ok": False, "error": _game_traceback(e)})
        self.close()

    def _threaded_reader(self, idle):
        """Read command lines on a daemon thread; call idle() about every 30 ms while none is ready."""
        import queue
        import threading
        lines = queue.Queue()
        reader = self.reader

        def pump():
            while True:
                try:
                    got = reader.readline()
                except (OSError, ValueError):  # socket reset, or the file was closed under us
                    got = b""
                lines.put(got)
                if not got:
                    return
        self.threaded = True
        threading.Thread(target=pump, name="witness-reader", daemon=True).start()
        failed = []

        def next_line():
            while True:
                try:
                    return lines.get(timeout=0.03)
                except queue.Empty:
                    pass
                try:
                    idle()
                except Exception as e:  # never let the idle hook kill the command loop
                    if not failed:
                        failed.append(e)
                        msg = "witness: idle hook failed (further errors suppressed): %s" % _game_traceback(e)
                        self.log("error", msg)
                        sys.stderr.write(msg + "\n")
        return next_line


_A = _Adapter()


class _LogBridge:
    """Forwards Python `logging` records (at the logger's configured level) to Witness."""

    def __new__(cls):
        import logging

        class Handler(logging.Handler):
            def emit(self, record):
                lvl = "error" if record.levelno >= logging.ERROR else \
                      "warn" if record.levelno >= logging.WARNING else "info"
                try:
                    _A.log(lvl, self.format(record))
                except Exception:  # never let logging break the game
                    pass
        return Handler()


# ---------------------------------------------------------------------------- public API

def run(name="game", fps=60, size=None, *, reset=None, on_input=None, update=None, snapshot=None,
        screenshot=None, audio=None, calls=None, namespace=None, perf=None, keys=None,
        engine="python", language="python", capture_logging=True, touch=False, idle=None):
    """Connect to the Witness CLI and serve commands until it says quit (or disconnects).

    Handlers (all optional except `update` and `snapshot`):
      reset(seed[, scene[, params]])  return the game to its deterministic initial state
      on_input(event)                 apply one protocol input event (called at the start of its frame).
                                      Touch events ({"type": "touch", "id", "x", "y", "phase",
                                      "pressure"}) for finger 0 are followed by the matching mouse
                                      event with "from_touch": True, unless touch=True (the game
                                      handles touch itself; the hello then says "touch": true)
      update(dt)                      advance exactly one frame
      snapshot([paths])               JSON-able dict (expose state["entities"] = [{id, type, pos}])
      screenshot([scale])             (width, height, rgba bytes) or a protocol dict
      audio                           an AudioCapture (advanced/reset automatically) or a callable
      calls                           {"name": fn(*args)} game-specific commands
      namespace                       dict (or callable returning one) for `eval`; default __main__
      perf()                          extra perf fields, e.g. {"counts": {...}}
      idle()                          called about every 30 ms while waiting for the next command
                                      (e.g. pump a visible window's events in watch mode); commands
                                      are then read on a background thread. Falls back to the
                                      module-level witness.IDLE. Exceptions are logged once.
    Returns normally after quit so the game can exit cleanly.
    """
    if update is None or snapshot is None:
        raise WitnessError("witness.run needs at least update= and snapshot= handlers")
    if _A.connected:
        raise WitnessError("witness.run is already serving")
    calls = dict(calls or {})
    caps = ["step", "input", "snapshot", "logs", "perf", "eval"]
    for cap, present in (("reset", reset), ("screenshot", screenshot), ("audio", audio), ("call", calls)):
        if present:
            caps.append(cap)
    hello = {"protocol": PROTOCOL, "name": name, "engine": engine, "language": language,
             "fps": fps, "capabilities": caps,
             "calls": [_describe_call(n, f) for n, f in calls.items()]}
    if size:
        hello["size"] = list(size)
    if keys:
        hello["keys"] = list(keys)
    if touch:
        hello["touch"] = True
    _A.size = tuple(size) if size else None
    h = {"fps": fps, "reset": reset, "on_input": on_input, "update": update, "snapshot": snapshot,
         "screenshot": screenshot, "audio": audio, "calls": calls, "namespace": namespace,
         "perf": perf, "capabilities": caps, "touch": bool(touch),
         "idle": idle if idle is not None else IDLE}
    bridge = None
    if capture_logging:
        import logging
        bridge = _LogBridge()
        logging.getLogger().addHandler(bridge)
    _A.connect(hello)
    try:
        _A.serve(h)
    finally:
        _A.close()
        if bridge is not None:
            import logging
            logging.getLogger().removeHandler(bridge)


def seed():
    """The seed to feed the game's RNG: from the last `reset`, or the replay header when recording."""
    if _A.seed is not None:
        return _A.seed
    if recording():
        return start_recording()["seed"]
    return 1


def frame():
    """The frame being simulated (inside update) or about to be simulated."""
    return _A.frame


def time():
    """Simulated seconds since reset."""
    return _A.time


def log(level, message):
    """Send a log line ("info" | "warn" | "error"). Errors fail Witness tests. No-op when inactive."""
    if _A.connected:
        _A.log(level, message)


def info(message):
    log("info", message)


def warn(message):
    log("warn", message)


def error(message):
    log("error", message)


def input_events():
    """Events applied at the current frame, for games that pull input instead of using on_input."""
    return list(_A.due)


def is_down(key):
    """Whether a Witness key (e.g. "right", "space") is held, from injected key events."""
    return key in _A.down


# ---------------------------------------------------------------------------- recording (replays)

class _Recorder:
    def __init__(self, path, name, fps, seed_value):
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, exist_ok=True)
        self.file = open(path, "w", encoding="utf-8", newline="\n", buffering=1)
        self.f = 0
        self.mark = None
        self.seed = seed_value
        started = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
        self.file.write(_dumps({"replay": 1, "name": name, "seed": seed_value, "fps": fps,
                                "started": started}) + "\n")

    def frame(self, dt, events):
        line = {"f": self.f, "dt": float(dt)}  # full precision: replays must be exact
        # mouse events synthesized from a finger are dropped: replay recreates them from the touch
        events = [_replay_event(e) for e in events or ()
                  if e and not (e.get("type") == "mouse" and e.get("from_touch"))]
        if events:
            line["in"] = events
        if self.mark:
            line["mark"], self.mark = self.mark, None
        self.file.write(_dumps(line) + "\n")
        self.f += 1

    def close(self):
        try:
            self.file.close()
        except OSError:
            pass


def start_recording(name="game", fps=60, seed=None):
    """Open the WITNESS_RECORD replay (once) and return {"seed", "path"}. No-op unless recording().

    The seed comes from `seed`, else WITNESS_SEED, else a fresh random one; seed your RNG with
    witness.seed() so the replay can reproduce the session.
    """
    if not recording():
        return {"seed": _A.seed if _A.seed is not None else 1, "path": None}
    if _A.recorder is None:
        if seed is None:
            env = os.environ.get("WITNESS_SEED")
            seed = int(env) if env else int.from_bytes(os.urandom(3), "little") + 1
        _A.recorder = _Recorder(os.environ["WITNESS_RECORD"], name, fps, int(seed))
        _A.seed = int(seed)
        import atexit
        atexit.register(_A.recorder.close)
    return {"seed": _A.recorder.seed, "path": os.environ["WITNESS_RECORD"]}


def record_frame(dt, events=None):
    """Append one replay line for a frame of normal play (the dt it ran with and its input events).

    Call it once per frame, after the frame, with the events in protocol shape
    ({"type": "key", "key": "d", "down": True} ...). Events queued with record_event() /
    record_touch() since the last call come first. Mouse events marked "from_touch" are skipped
    (replay recreates them from the touch). Does nothing unless recording().
    """
    if _A.recorder is None:
        if not recording():
            return
        start_recording()
    pending, _A.rec_pending = _A.rec_pending, []
    _A.recorder.frame(dt, pending + list(events or ()))


def record_event(event):
    """Queue one protocol-shape input event for the current frame's replay line (written by the
    next record_frame). Does nothing unless recording()."""
    if event and recording():
        _A.rec_pending.append(dict(event))


def record_touch(id, x, y, phase, pressure=None):  # noqa: A002 - "id" is the protocol's name
    """Queue a finger for the current frame's replay line: id 0 = first finger down (keep it
    stable until "up"), x/y in logical pixels (convert normalized 0..1 touch coordinates), phase
    "down" | "move" | "up". Don't also record the mouse events the platform synthesizes from the
    touch (pygame: event.touch); replay recreates them. Does nothing unless recording()."""
    if not recording():
        return
    e = {"type": "touch", "id": int(id), "x": x, "y": y, "phase": phase if phase in _PHASES else "move"}
    if pressure is not None:
        e["pressure"] = pressure
    _A.rec_pending.append(e)


def mark(label="F8"):
    """Flag the current moment in the replay (bind it to F8). Does nothing unless recording()."""
    if _A.recorder is not None:
        _A.recorder.mark = str(label)
