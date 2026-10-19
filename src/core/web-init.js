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

// Safe-area emulation (--safe-insets / launch.safeInsets): headless engines have no notch, so env(safe-area-inset-*) is
// 0 there. This rewrites every env(safe-area-inset-top|right|bottom|left[, fallback]) the page's CSS uses to the
// device's inset in CSS px (the measure ui --safe preset for its orientation): rules in same-origin style sheets
// (<style>, <link>, @import, constructed and adopted sheets, shadow roots; custom properties and shorthands included,
// through each rule's cssText), inline style attributes, and CSS set from script (insertRule on a sheet or an
// @media/@supports rule, replace/replaceSync, style.setProperty, style.cssText, style.paddingLeft = …). Re-applied when
// the DOM changes and when a sheet or @import loads. A page without <meta name=viewport content="…viewport-fit=cover">
// gets 0, as on the device (iOS keeps such a page inside the safe area). Cross-origin sheets can't be read: counted.
// Serialized with Function.prototype.toString like webInit: self-contained.
//   globalThis.__witnessSafe.info() -> { insets: {top, right, bottom, left}, cover, rewritten (distinct uses), rewrites
//     (calls that rewrote: a HUD setting style.cssText every frame counts each), bySource: {stylesheet, inline,
//     script}, crossOrigin, sheets, missed: {count, where: ["#hud (style sheet)", …]} }
export function safeInsetsInit(insets) {
  const G = globalThis;
  if (G.__witnessSafe || !G.document) return;
  const px = { top: +insets.top || 0, right: +insets.right || 0, bottom: +insets.bottom || 0, left: +insets.left || 0 };
  const S = { insets: px, rewritten: 0, rewrites: 0, bySource: { stylesheet: 0, inline: 0, script: 0 }, crossOrigin: 0, sheets: 0 };
  // viewport-fit=cover: without it iOS lays the page out inside the safe area and env(safe-area-inset-*) is 0
  const cover = () => {
    const m = G.document.querySelector && G.document.querySelector('meta[name="viewport" i]');
    return !!m && /viewport-fit\s*=\s*cover/i.test(m.getAttribute("content") || "");
  };
  const has = (t) => typeof t === "string" && t.toLowerCase().indexOf("safe-area-inset") >= 0;
  const ENV = /env\(\s*safe-area-inset-(top|right|bottom|left)\b/gi;
  // every env(safe-area-inset-x[, fallback]) with its fallback's parentheses balanced (any depth: var(--x, calc(…)))
  const replaceEnv = (text, use) => {
    let out = "", last = 0, m;
    ENV.lastIndex = 0;
    while ((m = ENV.exec(text))) {
      let depth = 0, i = m.index + 3;
      for (; i < text.length; i++) { const ch = text[i]; if (ch === "(") depth++; else if (ch === ")" && --depth === 0) break; }
      if (i >= text.length) break;   // unbalanced: left as it is
      out += text.slice(last, m.index) + use(m[1].toLowerCase(), m.index);
      last = i + 1;
      ENV.lastIndex = last;
    }
    return out + text.slice(last);
  };
  // a use's place in a text: the selector (when the text is a rule) and the property it is in
  const placeOf = (text, at) => {
    const before = text.slice(0, at), open = before.lastIndexOf("{");
    const prop = before.slice(Math.max(before.lastIndexOf(";"), open) + 1).split(":")[0].trim().toLowerCase();
    const sel = open >= 0 ? before.slice(before.lastIndexOf("}", open) + 1, open).trim() : "";
    return `${sel}|${prop}`;
  };
  // uses are counted once per place: target (a style declaration, a sheet or a rule) + selector + property (+ the
  // n-th env() in it); a HUD that sets the same style every frame is one use
  const uses = new WeakMap();
  const rewrite = (text, source, target, prop = "") => {
    if (!has(text)) return text;
    const zero = !cover(), keys = [], nth = new Map();
    const out = replaceEnv(text, (side, at) => {
      const k = prop ? `|${prop}` : placeOf(text, at);
      nth.set(k, (nth.get(k) || 0) + 1);
      keys.push(`${k}#${nth.get(k)}`);
      return `${zero ? 0 : px[side]}px`;
    });
    if (keys.length) {
      S.rewrites += keys.length;
      let set = target ? uses.get(target) : null;
      if (target && !set) uses.set(target, (set = new Set()));
      for (const k of keys) { if (set) { if (set.has(k)) continue; set.add(k); } S.rewritten++; S.bySource[source]++; }
    }
    return out;
  };
  const SR = G.CSSStyleRule && G.CSSStyleRule.prototype, sd = SR && Object.getOwnPropertyDescriptor(SR, "style");
  const seenSheets = new WeakSet(), crossSheets = new WeakSet();
  const isImport = (r) => "styleSheet" in r && "href" in r && !("selectorText" in r);
  let pending = false;
  // a sheet is done once walked with every @import in it loaded (until then it is walked again: an import still
  // loading has no rules yet); script changes to a done sheet are rewritten as they come in
  const walk = (rules) => {
    let done = true;
    for (const r of Array.from(rules || [])) {
      const st = sd && sd.get && r instanceof G.CSSStyleRule ? sd.get.call(r) : r.style;   // the declaration itself, not its wrapper (below)
      if (st && has(st.cssText)) { const t = rewrite(st.cssText, "stylesheet", st); try { st.cssText = t; } catch { /* read-only */ } }
      if (isImport(r)) { if (!r.styleSheet || !sheet(r.styleSheet, true)) done = false; }
      if (r.cssRules) done = walk(r.cssRules) && done;   // @media, @supports, @layer, nesting
    }
    return done;
  };
  const sheet = (sh, imported = false) => {
    if (seenSheets.has(sh) || crossSheets.has(sh)) return true;
    let rules;
    try { rules = sh.cssRules; } catch { crossSheets.add(sh); S.crossOrigin++; return true; }
    if (rules == null || (imported && !rules.length)) { pending = true; return false; }   // still loading
    if (!walk(rules)) { pending = true; return false; }
    seenSheets.add(sh);
    S.sheets++;
    return true;
  };
  const inline = (el) => {
    const v = el.getAttribute && el.getAttribute("style");
    if (has(v)) el.setAttribute("style", rewrite(v, "inline", el.style));
  };
  // shadow roots (open or closed: attachShadow is watched; declarative ones are found on their hosts)
  const roots = new Set();
  const OBS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] };
  let observer = null;
  const watchRoot = (root) => { if (!root || roots.has(root)) return; roots.add(root); if (observer) observer.observe(root, OBS); };
  const scopes = () => [G.document, ...roots];
  let retries = 0;
  const scan = (els) => {
    pending = false;
    for (const d of scopes()) {
      for (const sh of Array.from(d.styleSheets || [])) sheet(sh);
      for (const sh of Array.from(d.adoptedStyleSheets || [])) sheet(sh);
    }
    const look = (el) => { if (el.shadowRoot) watchRoot(el.shadowRoot); if (el.hasAttribute && el.hasAttribute("style")) inline(el); };
    if (!els) { for (const d of scopes()) for (const el of Array.from(d.querySelectorAll ? d.querySelectorAll("*") : [])) look(el); }
    else for (const el of els) look(el);
    // an @import still loading: look again shortly (its load event doesn't reach the document in every engine)
    if (pending && retries++ < 400) setTimeout(() => scan([]), 25);
    else if (!pending) retries = 0;
  };
  // CSS set from script: rewritten on the way in
  const P = G.CSSStyleSheet && G.CSSStyleSheet.prototype;
  if (P) {
    const ins = P.insertRule;
    if (ins) P.insertRule = function (rule, ...a) { return ins.call(this, rewrite(rule, "script", this), ...a); };
    const rep = P.replace, repS = P.replaceSync;
    if (rep) P.replace = function (t) { return rep.call(this, rewrite(t, "script", this)); };
    if (repS) P.replaceSync = function (t) { return repS.call(this, rewrite(t, "script", this)); };
  }
  const GR = G.CSSGroupingRule && G.CSSGroupingRule.prototype;   // @media / @supports / @layer blocks
  if (GR && GR.insertRule) { const gins = GR.insertRule; GR.insertRule = function (rule, ...a) { return gins.call(this, rewrite(rule, "script", this), ...a); }; }
  const patched = new Set();
  for (const C of [G.CSSStyleDeclaration, G.CSSStyleProperties, G.CSS2Properties]) {
    const D = C && C.prototype;
    if (!D || patched.has(D)) continue;
    patched.add(D);
    if (Object.prototype.hasOwnProperty.call(D, "setProperty")) {
      const setP = D.setProperty;
      D.setProperty = function (k, v, ...a) { return setP.call(this, k, rewrite(v, "script", this, String(k).toLowerCase()), ...a); };
    }
    // style.cssText = … and the named properties (style.paddingLeft = …, style["padding-left"] = …)
    for (const name of Object.getOwnPropertyNames(D)) {
      const d = Object.getOwnPropertyDescriptor(D, name);
      if (!d || !d.set || !d.configurable || name === "parentRule" || name === "length") continue;
      const prop = name === "cssText" ? "" : name.includes("-") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^webkit-/, "-webkit-");
      Object.defineProperty(D, name, { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { d.set.call(this, typeof v === "string" ? rewrite(v, "script", this, prop) : v); } });
    }
  }
  // an engine whose named properties aren't accessors (Chromium: an interceptor on each declaration) can't be patched
  // above: a style rule's declaration is handed out wrapped (one wrapper per declaration), its sets rewritten. An
  // element's style needs none (a set changes its style attribute, which the observer sees)
  const accessors = [G.CSSStyleDeclaration, G.CSSStyleProperties].some((C) => C && C.prototype && Object.getOwnPropertyDescriptor(C.prototype, "paddingLeft"));
  if (sd && sd.get && sd.configurable && !accessors && G.Proxy) {
    const wrapped = new WeakMap();
    const kebab = (k) => (k.includes("-") ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^webkit-/, "-webkit-"));
    Object.defineProperty(SR, "style", { configurable: true, enumerable: sd.enumerable, set: sd.set, get() {
      const decl = sd.get.call(this);
      if (!decl || typeof decl !== "object") return decl;
      let w = wrapped.get(decl);
      if (!w) {
        w = new G.Proxy(decl, {
          get: (t, k) => { const v = t[k]; return typeof v === "function" ? v.bind(t) : v; },
          set: (t, k, v) => { t[k] = typeof k === "string" && typeof v === "string" ? rewrite(v, "script", t, k === "cssText" ? "" : kebab(k)) : v; return true; },
        });
        wrapped.set(decl, w);
      }
      return w;
    } });
  }
  const AS = G.Element && G.Element.prototype.attachShadow;
  if (AS) G.Element.prototype.attachShadow = function (...a) { const r = AS.apply(this, a); watchRoot(r); return r; };
  // only what changed: elements whose style attribute was set, added subtrees, and sheets not done yet
  observer = new G.MutationObserver((records) => {
    const els = [];
    for (const r of records) {
      if (r.type === "attributes") els.push(r.target);
      else for (const n of Array.from(r.addedNodes || [])) if (n.nodeType === 1) { els.push(n); if (n.querySelectorAll) els.push(...n.querySelectorAll("*")); }
    }
    scan(els);
  });
  observer.observe(G.document, OBS);
  for (const r of roots) observer.observe(r, OBS);
  G.document.addEventListener("load", () => scan([]), true);   // a <link> sheet finished loading
  G.document.addEventListener("DOMContentLoaded", () => scan());
  // what is still there: env(safe-area-inset-*) left in a readable rule or a style attribute (nothing rewrote it)
  const leftovers = () => {
    const where = [];
    const look = (rules, what) => {
      for (const r of Array.from(rules || [])) {
        if (r.style && has(r.style.cssText)) where.push(`${r.selectorText || (r.keyText ? `@keyframes ${r.parentRule && r.parentRule.name ? `${r.parentRule.name} ` : ""}${r.keyText}` : "a rule")} (${what})`);
        if (isImport(r) && r.styleSheet) { try { look(r.styleSheet.cssRules, `@import ${String(r.href).replace(/^.*\//, "")}`); } catch { /* cross-origin */ } }
        if (r.cssRules) look(r.cssRules, what);
      }
    };
    for (const d of scopes()) {
      const sh = d !== G.document ? " in a shadow root" : "";
      for (const s of [...Array.from(d.styleSheets || []), ...Array.from(d.adoptedStyleSheets || [])]) { try { look(s.cssRules, `${s.href ? s.href.replace(/^.*\//, "") : "style sheet"}${sh}`); } catch { /* cross-origin */ } }
      for (const el of Array.from(d.querySelectorAll ? d.querySelectorAll("[style]") : [])) if (has(el.getAttribute("style"))) where.push(`${el.id ? `#${el.id}` : el.tagName.toLowerCase()} (inline${sh})`);
    }
    return { count: where.length, where: where.slice(0, 5) };
  };
  S.info = () => { scan(); return { insets: S.insets, cover: cover(), rewritten: S.rewritten, rewrites: S.rewrites, bySource: { ...S.bySource }, crossOrigin: S.crossOrigin, sheets: S.sheets, missed: leftovers() }; };
  G.__witnessSafe = S;
}
