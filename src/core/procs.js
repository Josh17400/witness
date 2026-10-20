// Witness core: the processes Witness starts (games, dev servers) and what must be undone when the CLI ends for any
// reason: a die(), an uncaught error, Ctrl-C, SIGTERM (a test runner's timeout), SIGHUP (a closed terminal).
// Children are killed with their whole tree (a shell's game, npm's dev server), and exit hooks (budget slots) run.
import { spawnSync } from "node:child_process";

const live = new Set();      // tracked children (games, dev servers)
const hooks = new Set();     // sync callbacks run at exit (slot release)
let installed = false;
const POSIX = process.platform !== "win32";

/**
 * Kill a process and everything it started: taskkill /T /F on Windows; on posix its process group when it leads one
 * (spawned with detached: true), else the pid alone. pidFallback: false skips the pid-alone try when the group is gone
 * (a group leader's group gone means the leader is gone too: its pid may already belong to another process).
 */
export function killTree(pid, { group = POSIX, signal = "SIGTERM", pidFallback = true } = {}) {
  if (!pid) return;
  if (!POSIX) { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15000 }); return; }
  if (group) { try { process.kill(-pid, signal); return; } catch { /* not a group leader, or gone */ } }
  if (!pidFallback) return;
  try { process.kill(pid, signal); } catch { /* gone */ }
}

/**
 * Track a spawned child (spawn it with detached: process.platform !== "win32", so on posix it leads its own group):
 * child.kill() then takes the whole tree, and the tree is killed when this process exits. On posix the group is
 * killed even after its leader exited (a shell gone, its server still running); on Windows a dead pid has no tree.
 */
export function track(child) {
  if (!child || child.pid == null) return child;
  child.kill = (signal = "SIGTERM") => {
    if (!POSIX && (child.exitCode !== null || child.signalCode !== null)) return false;
    // the pid alone only while it is still ours (it exited: a reused pid could be anyone's)
    killTree(child.pid, { signal, pidFallback: child.exitCode === null && child.signalCode === null });
    return true;
  };
  live.add(child);
  if (!POSIX) child.once("exit", () => live.delete(child));
  install();
  return child;
}
/** Stop tracking (after the caller stopped it itself). */
export function untrack(child) { live.delete(child); }

/** Run fn (synchronously) when the process exits, once; returns a function that cancels it. */
export function atExit(fn) { hooks.add(fn); install(); return () => hooks.delete(fn); }

/** Kill every tracked tree and run the exit hooks now (synchronous: safe inside process.on("exit")). */
export function cleanupSync() {
  for (const c of live) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  live.clear();
  for (const fn of hooks) { try { fn(); } catch { /* best effort */ } }
  hooks.clear();
}

const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
function install() {
  if (installed) return;
  installed = true;
  process.on("exit", cleanupSync);
  let seen = 0;
  for (const [sig, code] of Object.entries(SIGNALS)) {
    try {
      process.on(sig, () => {
        const now = () => { cleanupSync(); process.exit(code); };
        // another handler owns this signal and exits (the play daemon's shutdown, Playwright closing its browser):
        // the exit hook above cleans up then; if it hasn't exited 15 s later (or on a second signal), do it here.
        // Alone, Node would die without running exit hooks: clean up and exit now.
        if (process.listenerCount(sig) > 1 && !seen++) { setTimeout(now, 15000).unref(); return; }
        now();
      });
    } catch { /* signal not supported on this platform */ }
  }
}
