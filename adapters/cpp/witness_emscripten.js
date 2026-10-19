// witness_emscripten.js — the browser half of witness.h in Emscripten (WebAssembly) builds.
// witness.h compiled by emcc has no sockets: its EM_JS functions hand every protocol line to this shim, which keeps
// one WebSocket to the Witness CLI (ws://<addr>/, the same port the CLI listens on) and passes each command back into
// the C side (witness_emscripten_recv). Commands run synchronously inside that call: the game steps only when told.
//
// Link it in one of two ways (both before the game starts):
//   emcc ... --pre-js path/to/witness/witness_emscripten.js          (recommended: part of the .js output)
//   <script src="witness_emscripten.js"></script> before the Emscripten loader script in the page
// It does nothing unless the page URL has ?witness=host:port (the CLI adds it) or globalThis.WITNESS_CONFIG.addr is set.
//
// In witness mode it also
//   * keeps WebGL drawing buffers (preserveDrawingBuffer), so a canvas can be read back at any time;
//   * answers "screenshot" itself from the canvas (Module.canvas, else the largest <canvas>) when the game's hello
//     has no screenshot handler;
//   * forwards gestures (the C side marks input events that browsers count as a user gesture) to the page's audio
//     policy (globalThis.__witnessWeb, installed by the CLI for browser launches).
// Plain script (no import/export): it must work as --pre-js, as a <script>, and under Node (Witness's own tests).
// Closure-safe (emcc -O2 --closure 1 runs Closure ADVANCED over --pre-js code and renames dotted property names):
// every name that crosses the bundle's edge (JSON lines, WITNESS_CONFIG, the CLI's __witnessWeb, Module, the object
// the EM_JS functions in witness.h pass in, and this file's own api) is accessed with quoted ['names'].
(function () {
  "use strict";
  var G = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this;
  if (G["WitnessEmscripten"]) return;
  var DEFAULT_ADDR = "127.0.0.1:7357";
  var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

  function readAddr() {
    var c = G["WITNESS_CONFIG"] || {};
    if (c["addr"]) return String(c["addr"]);
    try {
      if (G.location && G.location.search) {
        var q = new URLSearchParams(G.location.search);
        if (q.has("witness")) return q.get("witness") || DEFAULT_ADDR;
      }
    } catch (e) { /* no URL */ }
    if (typeof process !== "undefined" && process["env"] && process["env"]["WITNESS_ADDR"]) return process["env"]["WITNESS_ADDR"];
    return null;
  }
  var ADDR = readAddr();

  var S = {
    ws: null, open: false, closed: false, queue: [], c: null, hello: null, ownShot: false, attempts: 0, log: [],
  };

  function text(heap, ptr, len) {
    var bytes = heap.subarray(ptr, ptr + len);
    if (dec) return dec.decode(bytes);
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return decodeURIComponent(escape(s));
  }
  function utf8(s) {
    if (enc) return enc.encode(s);
    var b = unescape(encodeURIComponent(s)), out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function warn(msg) { try { (G.console && (G.console.warn || G.console.log)).call(G.console, "[witness] " + msg); } catch (e) { /* no console */ } }

  function rawSend(s) {
    if (S.closed) return;
    if (S.open) { try { S.ws.send(s); } catch (e) { warn("send failed: " + e.message); } }
    else S.queue.push(s);
  }

  // ---- screenshots from the canvas (when the C side has no screenshot handler)
  function findCanvas() {
    var M = G["Module"];
    if (M && M["canvas"] && M["canvas"].width) return M["canvas"];
    if (!G.document) return null;
    var best = null, area = -1, list = G.document.querySelectorAll("canvas");
    for (var i = 0; i < list.length; i++) { var a = list[i].width * list[i].height; if (a > area) { area = a; best = list[i]; } }
    return best;
  }
  function b64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("base64");
    var s = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function canvasShot(scale) {
    var cv = findCanvas();
    if (!cv) throw new Error("no <canvas> to read (set Module.canvas)");
    var w = Math.max(1, Math.round(cv.width * scale)), h = Math.max(1, Math.round(cv.height * scale));
    var off = G.document.createElement("canvas");
    off.width = w; off.height = h;
    var c2 = off.getContext("2d", { "willReadFrequently": true });
    c2.imageSmoothingEnabled = scale < 1;
    c2.drawImage(cv, 0, 0, w, h);
    return { "width": w, "height": h, "format": "rgba8", "data": b64(c2.getImageData(0, 0, w, h).data) };
  }

  // ---- incoming commands
  function intoC(line) {
    var c = S.c, bytes = utf8(line + "\n");
    var ptr = c["inbuf"](bytes.length);
    if (!ptr) { warn("out of memory for a command (" + bytes.length + " bytes)"); return; }
    c["heap"]().set(bytes, ptr);   // heap() after inbuf(): growing memory replaces the old view
    c["recv"](bytes.length);
  }
  function onLine(line) {
    if (!line.trim()) return;
    if (S.ownShot && line.indexOf("\"screenshot\"") >= 0) {
      var m = null;
      try { m = JSON.parse(line); } catch (e) { /* the C side reports bad lines */ }
      if (m && m["cmd"] === "screenshot") {
        var reply;
        try { var r = canvasShot(+m["scale"] > 0 ? +m["scale"] : 1); reply = { "id": m["id"], "ok": true, "width": r["width"], "height": r["height"], "format": r["format"], "data": r["data"] }; }
        catch (e) { reply = { "id": m["id"], "ok": false, "error": String(e && e.message || e) }; }
        rawSend(JSON.stringify(reply));
        return;
      }
    }
    try { intoC(line); } catch (e) { warn("a command threw: " + (e && e.stack || e)); }
  }

  function connect() {
    var WS = G.WebSocket;
    if (!WS) { warn("no WebSocket here: can't reach Witness"); return; }
    var ws;
    try { ws = new WS("ws://" + ADDR + "/"); } catch (e) { warn("can't open ws://" + ADDR + "/: " + e.message); return; }
    S.ws = ws;
    ws.onopen = function () {
      S.open = true;
      var q = S.queue.splice(0);
      for (var i = 0; i < q.length; i++) ws.send(q[i]);
    };
    ws.onmessage = function (e) {
      var data = typeof e.data === "string" ? e.data : String(e.data);
      var lines = data.split("\n");
      for (var i = 0; i < lines.length; i++) onLine(lines[i]);
    };
    ws.onerror = function () { /* onclose follows */ };
    ws.onclose = function () {
      var wasOpen = S.open;
      S.open = false;
      if (!wasOpen && !S.closed && ++S.attempts < 40) { setTimeout(connect, 250); return; }   // CLI not listening yet
      if (!S.closed) { S.closed = true; if (S.c && S.c["closed"]) { try { S.c["closed"](); } catch (e) { /* runtime gone */ } } }
      if (!wasOpen) warn("can't reach Witness at ws://" + ADDR + "/");
    };
  }

  function patchWebGL() {
    var C = G.HTMLCanvasElement;
    if (!C || C.prototype.__witnessPatched) return;
    var orig = C.prototype.getContext;
    C.prototype.getContext = function (type, attrs) {
      if (/^(webgl2?|experimental-webgl)$/.test(type)) attrs = Object.assign({}, attrs, { "preserveDrawingBuffer": true });
      return orig.call(this, type, attrs);
    };
    C.prototype.__witnessPatched = true;
  }

  var api = {
    "version": "1.0.0",
    /** 1 when the page should talk to Witness (?witness= / WITNESS_CONFIG.addr). */
    "active": function () { return !!ADDR; },
    "addr": function () { return ADDR; },
    /** Write the address as a C string at out (size bytes incl. NUL). Returns its length. */
    "addrTo": function (heap, out, size) {
      var b = utf8(ADDR || ""), n = Math.min(b.length, Math.max(0, size - 1));
      heap.set(b.subarray(0, n), out);
      heap[out + n] = 0;
      return n;
    },
    /** From witness_connect(): c = {heap(), inbuf(n), recv(n), closed()}. Connects; sends queue until open. */
    "open": function (c) {
      if (!ADDR) return 0;
      S.c = c; S.closed = false; S.queue = []; S.attempts = 0;
      connect();
      return 1;
    },
    /** One protocol line from C (the hello, replies, events). */
    "send": function (heap, ptr, len) {
      var line = text(heap, ptr, len).replace(/\n+$/, "");
      if (!S.hello && line.indexOf("{\"hello\"") === 0) {
        try {
          var h = JSON.parse(line);
          var hh = h["hello"], caps = hh["capabilities"] || (hh["capabilities"] = []);
          if (caps.indexOf("screenshot") < 0 && G.document) { caps.push("screenshot"); S.ownShot = true; }
          hh["adapter"] = (hh["adapter"] || "witness.h") + " + witness_emscripten.js " + api["version"];
          S.hello = hh;
          line = JSON.stringify(h);
        } catch (e) { /* send it as it is */ }
      }
      rawSend(line);
    },
    "close": function () {
      S.closed = true;
      if (S.ws) { try { S.ws.close(); } catch (e) { /* gone */ } }
    },
    /** C marks input that browsers count as a user gesture (1 before the game's input handler, 0 after). */
    "gesture": function (on) {
      var w = G["__witnessWeb"];
      if (!w) return;
      if (on) w["begin"](); else w["end"]();
    },
  };
  G["WitnessEmscripten"] = api;
  if (ADDR) patchWebGL();
})();
