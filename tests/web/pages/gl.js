// A WebGL2 game that opens no audio in witness mode (like an SDL build that skips SDL_OpenAudioDevice there): doctor
// reports the WebGL renderer, and --no-auto-unlock says there is no AudioContext to test.
import witness from "/witness/witness.js";

const canvas = document.getElementById("game");
const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
let x;
function reset() { x = 0; }
function update() { x = (x + 1) % 160; }
function render() {
  gl.clearColor(0.1, 0.2, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST); gl.scissor(x, 40, 10, 10); gl.clearColor(1, 0.8, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
}
let last = performance.now();
function frame(now) { if (now - last >= 16) { update(); last = now; } render(); requestAnimationFrame(frame); }
reset();
requestAnimationFrame(frame);

await witness.start({
  name: "WebGL, no audio", fps: 60, size: [160, 90], canvas,
  reset: () => reset(),
  snapshot: () => ({ x }),
});
