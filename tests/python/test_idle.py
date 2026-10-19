"""Stdlib-only test of the Python adapter's idle= hook (watch mode) and the plain blocking path.

Run: python tests/python/test_idle.py   (prints "N passed, M failed"; exits non-zero on failure)

One process: a fake Witness CLI (TCP server thread) talks to witness.run() in the main thread.
"""
import json
import os
import socket
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "adapters", "python"))

import witness  # noqa: E402

GAP = 0.15
COMMANDS = [
    {"id": 1, "cmd": "reset", "seed": 7},
    {"id": 2, "cmd": "step", "frames": 3},
    {"id": 3, "cmd": "snapshot"},
    {"id": 4, "cmd": "quit"},
]

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("ok   " + name)
    else:
        failed += 1
        print("FAIL " + name + (": " + str(detail) if detail else ""))


def fake_cli(server, out, commands):
    """Accept the adapter, read its hello, send COMMANDS with gaps, collect the replies."""
    try:
        server.settimeout(10)
        conn, _ = server.accept()
        conn.settimeout(10)
        f = conn.makefile("rb")
        out["hello"] = json.loads(f.readline().decode("utf-8"))
        for msg in commands:
            time.sleep(GAP)
            conn.sendall((json.dumps(msg) + "\n").encode("utf-8"))
            line = f.readline()
            if not line:
                break
            out["replies"].append(json.loads(line.decode("utf-8")))
        f.close()
        conn.close()
    except Exception as e:  # reported by the main thread
        out["error"] = repr(e)
    finally:
        server.close()


def session(idle, commands=COMMANDS):
    """Run one witness.run() session against the fake CLI; return what happened."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    os.environ["WITNESS_ADDR"] = "127.0.0.1:%d" % server.getsockname()[1]
    out = {"replies": [], "hello": None, "error": None}
    cli = threading.Thread(target=fake_cli, args=(server, out, commands), daemon=True)
    cli.start()

    state = {"x": 0, "seed": None, "reader_threads": []}

    def reset(seed):
        state["x"], state["seed"] = 0, seed

    def update(dt):
        state["x"] += 1
        state["reader_threads"].append(any(t.name == "witness-reader" for t in threading.enumerate()))

    def snapshot():
        return {"x": state["x"], "seed": state["seed"]}

    t0 = time.perf_counter()
    kw = {"idle": idle} if idle is not None else {}
    witness.run(name="idle test", fps=60, reset=reset, update=update, snapshot=snapshot, **kw)
    out["elapsed"] = time.perf_counter() - t0
    cli.join(5)
    out["cli_done"] = not cli.is_alive()
    out["state"] = state
    return out


def check_replies(tag, out):
    check(tag + ": fake CLI had no error", out["error"] is None, out["error"])
    check(tag + ": hello received", bool(out["hello"]) and out["hello"].get("hello", {}).get("name") == "idle test",
          out["hello"])
    r = out["replies"]
    check(tag + ": 4 replies, in order, all ok",
          [x.get("id") for x in r] == [1, 2, 3, 4] and all(x.get("ok") for x in r), r)
    if len(r) == 4:
        check(tag + ": step -> frame 3", r[1].get("frame") == 3, r[1])
        check(tag + ": snapshot state", r[2].get("frame") == 3 and r[2].get("state") == {"x": 3, "seed": 7}, r[2])
    check(tag + ": run() returned after quit", out["cli_done"] and not witness._A.connected)


def main():
    # 1. with idle=: commands read on a thread, idle pumped while waiting
    calls = {"n": 0}

    def idle():
        calls["n"] += 1

    out = session(idle)
    check_replies("idle", out)
    check("idle: idle called >= 3 times", calls["n"] >= 3, calls["n"])
    check("idle: reader thread used", all(out["state"]["reader_threads"]) and out["state"]["reader_threads"],
          out["state"]["reader_threads"])

    # 2. an idle hook that raises: logged once, the loop keeps going
    boom = {"n": 0}

    def bad_idle():
        boom["n"] += 1
        raise RuntimeError("idle exploded")

    stderr, sys.stderr = sys.stderr, _Capture()
    try:
        out = session(bad_idle)
    finally:
        captured, sys.stderr = sys.stderr.text, stderr
    check_replies("raising idle", out)
    check("raising idle: called repeatedly", boom["n"] >= 3, boom["n"])
    check("raising idle: reported once", captured.count("idle hook failed") == 1, captured)

    # 3. without idle: the blocking readline path, no reader thread
    out = session(None)
    check_replies("no idle", out)
    check("no idle: no reader thread", out["state"]["reader_threads"] and not any(out["state"]["reader_threads"]),
          out["state"]["reader_threads"])
    check("no idle: reader thread gone after the idle sessions",
          not any(t.name == "witness-reader" and t.is_alive() for t in threading.enumerate()))

    # 4. the CLI disconnects without quit while idle is pumping: run() still ends cleanly
    calls["n"] = 0
    out = session(idle, COMMANDS[:2])
    check("disconnect: replies before the drop", [x.get("id") for x in out["replies"]] == [1, 2], out["replies"])
    check("disconnect: run() returned", out["cli_done"] and not witness._A.connected and out["elapsed"] < 5, out.get("elapsed"))

    print("%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


class _Capture:
    def __init__(self):
        self.text = ""

    def write(self, s):
        self.text += s

    def flush(self):
        pass


if __name__ == "__main__":
    sys.exit(main())
