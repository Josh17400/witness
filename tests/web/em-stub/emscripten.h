/* A stand-in for <emscripten.h> so Witness's tests can compile witness.h's web bridge (WITNESS_WEB_BRIDGE) natively.
 * Each EM_JS function becomes a plain C declaration; bridge_host.c implements them by talking to bridge-node.mjs,
 * which runs the real adapters/cpp/witness_emscripten.js. Not for games: real web builds use emcc's emscripten.h. */
#ifndef WITNESS_EM_STUB_H
#define WITNESS_EM_STUB_H
#ifdef __cplusplus
#define WITNESS_EM_STUB_C extern "C"
#else
#define WITNESS_EM_STUB_C
#endif
#define EM_JS(ret, name, params, ...) WITNESS_EM_STUB_C ret name params
#define EMSCRIPTEN_KEEPALIVE
WITNESS_EM_STUB_C void emscripten_exit_with_live_runtime(void);
#endif
