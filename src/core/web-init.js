// Runs in the page before any of its scripts (Playwright addInitScript), for every browser launch.
// It is serialized with Function.prototype.toString, so it must not use anything from this module.
//
// globalThis.__witnessWeb:
//   * an audio autoplay policy, emulated the same way in every engine:
//       "auto"    (default) AudioContexts run from the start: Witness counts as the user's first gesture.
//       "gesture" (--no-auto-unlock) like iPhone Safari: a context starts "suspended" and resume() only works while a
//                 user gesture is being handled (a trusted keydown / mousedown / mouseup / touchend / click / pointerup
//                 of a finger, or Witness input marked as a gesture by an adapter: key down, mouse button, finger up).
//                 resume() outside a gesture stays pending until a later one succeeds; the call is counted as blocked.
//     Native AudioContexts are wrapped here; the JS adapter's captured contexts register themselves (track()).
//     The state Witness reports is the emulated one (the engine's own may differ: headless pages play nothing).
//   * info(): device pixel ratio, viewport, user agent, touch points, standalone, every canvas with its backing size,
//     CSS box, image-rendering and context type (getContext is watched), and the audio contexts.
//   * webgl(): WebGL 1 / 2 availability, version and (unmasked) renderer, probed on a scratch canvas.
//   * standalone emulation (navigator.standalone, display-mode: standalone) for Home Screen web app profiles, and the
//     device's navigator.platform / maxTouchPoints ("iPhone" or "MacIntel", 5) for device profiles.
export function webInit(opts) {
  const G = globalThis;
  if (G.__witnessWeb) return;
  const realSetTimeout = G.setTimeout.bind(G);
  const W = {
    policy: opts && opts.policy === "gesture" ? "gesture" : "auto",
    depth: 0,
    trusted: 0,
    contexts: [],
    gestures: 0,
    inGesture() { return this.depth > 0 || this.trusted > 0; },
    begin() { this.depth++; this.gestures++; },
    end() { this.depth = Math.max(0, this.depth - 1); },
    allowResume() { return this.policy === "auto" || this.inGesture(); },
    /** entry: {kind, state(): string, unlock(): void, resumes, blocked, unlockedBy?} → its id */
    track(entry) { entry.id = this.contexts.length + 1; this.contexts.push(entry); return entry.id; },
    /** "auto": the synthetic gesture at connect: resume every context still suspended by the policy. */
    unlock() {
      let n = 0;
      this.begin();
      try { for (const e of this.contexts) if (e.policySuspended && e.state() === "suspended") { e.unlock("witness auto-unlock"); n++; } }
      finally { this.end(); }
      return n;
    },
    audio() {
      const list = this.contexts.map((e) => ({ id: e.id, kind: e.kind, state: e.state(), resumes: e.resumes, blocked: e.blocked, unlockedBy: e.unlockedBy || null, sampleRate: e.sampleRate || null }));
      const count = (s) => list.filter((c) => c.state === s).length;
      const running = count("running"), suspended = count("suspended"), closed = count("closed");
      return { policy: this.policy, contexts: list, running, suspended, closed, blocked: list.reduce((a, c) => a + c.blocked, 0), state: !list.length ? "none" : running ? "running" : suspended ? "suspended" : "closed" };
    },
    info() {
      const canvases = [];
      if (G.document) {
        for (const c of G.document.querySelectorAll("canvas")) {
          const r = c.getBoundingClientRect();
          let ir = "";
          try { ir = G.getComputedStyle(c).imageRendering; } catch { /* detached */ }
          canvases.push({ id: c.id || null, w: c.width, h: c.height, rect: [r.left, r.top, r.width, r.height], imageRendering: ir, context: ctxKind.get(c) || null });
        }
      }
      const nav = G.navigator || {};
      return {
        dpr: G.devicePixelRatio || 1, viewport: [G.innerWidth || 0, G.innerHeight || 0], screen: G.screen ? [G.screen.width, G.screen.height] : null,
        userAgent: nav.userAgent || "", platform: nav.platform || "", maxTouchPoints: nav.maxTouchPoints || 0, touchEvents: typeof G.TouchEvent === "function",
        standalone: nav.standalone === true, canvases, audio: this.audio(), webAudio: !this.noWebAudio,
      };
    },
  };
  G.__witnessWeb = W;

  // which context each canvas drew with (the first getContext that returned one), and what WebGL this engine offers
  const ctxKind = new WeakMap();
  const HCE = G.HTMLCanvasElement, realGetContext = HCE && HCE.prototype.getContext;
  if (realGetContext) {
    HCE.prototype.getContext = function (type, ...rest) {
      const c = realGetContext.call(this, type, ...rest);
      const k = String(type) === "experimental-webgl" ? "webgl" : String(type);
      if (c && !ctxKind.has(this)) ctxKind.set(this, k);
      else if (!c && !ctxKind.has(this) && /^webgl/.test(k)) ctxKind.set(this, `${k} (failed)`);   // asked, got none
      else if (c && String(ctxKind.get(this)).endsWith(" (failed)")) ctxKind.set(this, k);
      return c;
    };
  }
  W.webgl = () => {
    const probe = (kind) => {
      try {
        const c = G.document.createElement("canvas"), gl = realGetContext.call(c, kind);
        if (!gl) return { available: false };
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        const r = { available: true, version: gl.getParameter(gl.VERSION), vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        return r;
      } catch (e) { return { available: false, error: String((e && e.message) || e) }; }
    };
    return realGetContext && G.document ? { webgl: probe("webgl"), webgl2: probe("webgl2") } : null;
  };

  // trusted gestures (Playwright input, or a person on a watched page): activation lasts until the next task
  const activating = (e) => {
    if (!e.isTrusted) return;
    if (e.type === "keydown" && (e.key === "Escape" || e.key === "Esc")) return;
    if (e.type === "pointerup" && e.pointerType === "mouse") return;
    W.trusted++;
    realSetTimeout(() => { W.trusted = Math.max(0, W.trusted - 1); }, 0);
  };
  for (const t of ["keydown", "mousedown", "mouseup", "pointerup", "touchend", "click"]) G.addEventListener(t, activating, { capture: true });

  // native AudioContexts: emulate the policy on top of the engine's own context
  const wrap = (Native) => {
    if (typeof Native !== "function") return Native;
    function WitnessNativeAudioContext(...args) {
      const ctx = new Native(...args);
      const e = { kind: W.noWebAudio ? "silent stand-in" : "native", resumes: 0, blocked: 0, st: W.allowResume() ? "running" : "suspended", policySuspended: !W.allowResume(), waiting: [], sampleRate: ctx.sampleRate };
      const nResume = ctx.resume ? ctx.resume.bind(ctx) : () => Promise.resolve();
      const nSuspend = ctx.suspend ? ctx.suspend.bind(ctx) : () => Promise.resolve();
      const nClose = ctx.close ? ctx.close.bind(ctx) : () => Promise.resolve();
      const set = (s) => {
        if (e.st === s) return;
        e.st = s;
        try { ctx.dispatchEvent(new Event("statechange")); } catch { /* not an EventTarget here */ }
      };
      e.state = () => e.st;
      e.unlock = (by) => {
        if (e.st === "closed") return;
        e.policySuspended = false;
        if (!e.unlockedBy && e.st !== "running") e.unlockedBy = by;
        set("running");
        nResume().catch(() => {});
        for (const r of e.waiting.splice(0)) r();
      };
      Object.defineProperty(ctx, "state", { configurable: true, get: () => e.st });
      ctx.resume = () => {
        e.resumes++;
        if (e.st === "closed") return Promise.reject(new DOMException("the AudioContext is closed", "InvalidStateError"));
        if (W.allowResume()) { e.unlock(W.inGesture() ? "gesture" : "auto policy"); return Promise.resolve(); }
        e.blocked++;
        return new Promise((res) => e.waiting.push(res));
      };
      ctx.suspend = () => { if (e.st !== "closed") { e.policySuspended = false; set("suspended"); } return nSuspend().catch(() => {}); };
      ctx.close = () => { set("closed"); return nClose().catch(() => {}); };
      if (e.st === "running" && W.policy === "gesture") e.unlockedBy = "created in a gesture";
      if (e.st === "suspended") nSuspend().catch(() => {});
      W.track(e);
      return ctx;
    }
    WitnessNativeAudioContext.prototype = Native.prototype;
    return WitnessNativeAudioContext;
  };
  // An engine build without Web Audio (Playwright's WebKit for Windows has none): a silent stand-in, so a game that
  // creates an AudioContext at load still starts. Every node, param and method accepts anything and does nothing.
  if (!G.AudioContext && !G.webkitAudioContext) {
    W.noWebAudio = true;
    const silent = () => {
      const fn = function () {};
      const p = new Proxy(fn, {
        get(t, k) {
          if (k === "then") return undefined;   // not a thenable: awaiting it gives it back
          if (k === Symbol.toPrimitive) return () => 0;
          if (k === "currentTime" || k === "value" || k === "baseLatency" || k === "outputLatency" || k === "length" || k === "duration") return 0;
          if (k === "sampleRate") return 48000;
          if (k === "numberOfChannels" || k === "channelCount") return 1;
          if (typeof k === "symbol") return undefined;
          if (!(k in t)) t[k] = silent();
          return t[k];
        },
        set(t, k, v) { t[k] = v; return true; },
        apply() { return silent(); },
        construct() { return silent(); },
      });
      return p;
    };
    function SilentAudioContext() {
      const ctx = silent();
      for (const m of ["resume", "suspend", "close", "decodeAudioData"]) ctx[m] = () => Promise.resolve(silent());
      ctx.addEventListener = () => {};
      ctx.removeEventListener = () => {};
      ctx.dispatchEvent = () => true;
      return ctx;
    }
    G.AudioContext = SilentAudioContext;
  }
  const AC = G.AudioContext, WAC = G.webkitAudioContext, wAC = wrap(AC);
  if (AC) G.AudioContext = wAC;
  if (WAC) G.webkitAudioContext = WAC === AC ? wAC : wrap(WAC);

  // the device's navigator.platform and touch points, matching its user agent (headless engines report the host:
  // "Win32" and 0 or 1 touch points, so an iPad check or a touch-UI check would pick the desktop UI)
  const navProp = (k, v) => {
    if (v == null || !G.navigator) return;
    try { Object.defineProperty(Object.getPrototypeOf(G.navigator), k, { configurable: true, get: () => v }); } catch { /* read-only */ }
    try { if (G.navigator[k] !== v) Object.defineProperty(G.navigator, k, { configurable: true, get: () => v }); } catch { /* read-only */ }
  };
  if (opts) { navProp("platform", opts.platform); navProp("maxTouchPoints", opts.maxTouchPoints); }

  // Home Screen web app (iOS): navigator.standalone and the display-mode media query
  if (opts && opts.standalone && G.navigator) {
    try { Object.defineProperty(G.navigator, "standalone", { configurable: true, get: () => true }); } catch { /* read-only */ }
    const mm = G.matchMedia && G.matchMedia.bind(G);
    if (mm) {
      G.matchMedia = (q) => {
        const r = mm(q);
        const m = /\(\s*display-mode\s*:\s*([a-z-]+)\s*\)/i.exec(String(q));
        if (!m) return r;
        const matches = m[1].toLowerCase() === "standalone";
        return new Proxy(r, { get: (t, k) => (k === "matches" ? matches : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
      };
    }
  }
}
