// A stand-in for an Emscripten build of a C game that uses witness.h (Witness's tests have no emcc): the same
// boundary as the real thing. "C" here is JavaScript working on a real WebAssembly.Memory: the shim writes each
// command into the heap through inbuf()/recv(), and every reply goes out through WitnessEmscripten.send(HEAPU8, ptr,
// len), the call witness.h's EM_JS functions make. The game draws with WebGL (the shim reads the canvas back for
// screenshots: this hello has no screenshot handler), creates a native AudioContext at boot and resumes it when a
// finger lifts (inside the gesture window the C side opens, as witness.h does around the game's input handler).
// Witness mode never starts a requestAnimationFrame loop: the game steps only on "step".
(function () {
  const W = globalThis.WitnessEmscripten;
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 256 });
  let HEAPU8 = new Uint8Array(memory.buffer);
  const IN = 1024;                                  // command bytes land here
  let inLen = 0, grows = 0;
  const canvas = document.getElementById("canvas");
  const gl = canvas.getContext("webgl", { antialias: false });
  const audio = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  const g = { frame: 0, time: 0, seed: 1, x: 10, y: 16, held: new Set(), taps: 0, queue: [], logs: [] };

  function reset(seed) { g.seed = seed; g.frame = 0; g.time = 0; g.x = 10 + (seed % 7); g.y = 16; g.held.clear(); g.taps = 0; g.queue = []; }
  function render() {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(20 / 255, 24 / 255, 40 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(80 / 255, 200 / 255, 1, 1);
    for (let x = 0; x < 64; x += 2) { gl.scissor(x, 36 - 31, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); }   // a row of single pixels
    gl.scissor(Math.round(g.x), 36 - Math.round(g.y) - 4, 4, 4);   // GL's y goes up
    gl.clearColor(1, 210 / 255, 60 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  const activates = (e) => (e.type === "key" && e.down && e.key !== "escape") || (e.type === "mouse" && typeof e.down === "boolean") || (e.type === "touch" && e.phase === "up");
  function input(e) {
    if (e.type === "key") { if (e.down) g.held.add(e.key); else g.held.delete(e.key); }
    if (e.type === "touch" && e.phase === "up") { g.taps++; if (audio.state === "suspended") audio.resume(); }
  }
  function step(dt) {
    const due = g.queue.filter((e) => (e.frame | 0) <= g.frame);
    g.queue = g.queue.filter((e) => (e.frame | 0) > g.frame);
    for (const e of due) { const gesture = activates(e); if (gesture) W.gesture(1); input(e); if (gesture) W.gesture(0); }
    if (g.held.has("right")) g.x = Math.min(60, g.x + 30 * dt);
    if (g.held.has("left")) g.x = Math.max(0, g.x - 30 * dt);
    g.frame++; g.time += dt;
    render();
  }
  function reply(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj) + "\n");
    const at = IN + inLen + 4096;
    if (at + bytes.length > HEAPU8.length) { memory.grow(Math.ceil((at + bytes.length - HEAPU8.length) / 65536)); HEAPU8 = new Uint8Array(memory.buffer); grows++; }
    HEAPU8.set(bytes, at);
    W.send(HEAPU8, at, bytes.length);
  }
  function command(m) {
    const ok = (extra) => reply({ id: m.id, ok: true, ...extra });
    switch (m.cmd) {
      case "reset": reset(m.seed ?? 1); render(); return ok({});
      case "input": for (const e of m.events || []) g.queue.push(e); return ok({});
      case "step": { const n = Math.max(1, m.frames | 0); for (let i = 0; i < n; i++) step(Array.isArray(m.dts) ? m.dts[i] || 1 / 60 : m.dt || 1 / 60); return ok({ frame: g.frame, time: g.time }); }
      // "grew", not the count: grows follow the number of commands received (every 10th call), which isn't game state
      // (doctor's runs, and the logs read before each reset, change it)
      case "snapshot": return ok({ frame: g.frame, time: g.time, state: { player: { pos: [g.x, g.y] }, taps: g.taps, audio: audio.state, grew: grows > 0, entities: [{ id: 1, type: "Player", pos: [g.x, g.y] }] } });
      case "logs": return ok({ logs: g.logs.splice(0) });
      case "quit": ok({}); W.close(); return undefined;
      default: return reply({ id: m.id, ok: false, error: `unknown command '${m.cmd}'` });
    }
  }
  // the exported "C" functions the shim calls
  let calls = 0;
  function inbuf(n) {
    const need = IN + inLen + n + 1 + 8192;
    // also grow every 10th call, as a growing wasm heap would: the old HEAPU8 view is detached afterwards, so the shim
    // must write through a fresh heap() (a stale view would throw or write nowhere)
    if (need > HEAPU8.length || (++calls % 10 === 0 && memory.buffer.byteLength < 64 * 65536)) { memory.grow(Math.max(1, Math.ceil((need - HEAPU8.length) / 65536))); HEAPU8 = new Uint8Array(memory.buffer); grows++; }
    return IN + inLen;
  }
  function recv(n) {
    inLen += n;
    let start = 0;
    const view = HEAPU8.subarray(IN, IN + inLen);
    for (let i = 0; i < inLen; i++) {
      if (view[i] !== 10) continue;
      const line = new TextDecoder().decode(view.subarray(start, i));
      start = i + 1;
      if (line.trim()) command(JSON.parse(line));
    }
    HEAPU8.copyWithin(IN, IN + start, IN + inLen);
    inLen -= start;
    return 1;
  }
  reset(1);
  render();
  if (W && W.active()) {
    W.open({ heap: () => HEAPU8, inbuf, recv, closed: () => {} });
    reply({ hello: { protocol: 1, name: "Bridge mock", engine: "Emscripten mock", language: "c", fps: 60, size: [64, 36], capabilities: ["reset", "step", "input", "snapshot", "logs"] } });
  } else {
    const loop = () => { step(1 / 60); requestAnimationFrame(loop); };   // normal play
    requestAnimationFrame(loop);
  }
})();
