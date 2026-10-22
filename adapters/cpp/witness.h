/* witness.h - Witness adapter for C and C++ games. Single header, no dependencies.
 * Protocol v1: https://github.com/ (see docs/PROTOCOL.md in the Witness repo)
 *
 * USAGE
 *   In exactly ONE source file (ideally its own, e.g. witness_impl.c / .cpp):
 *       #define WITNESS_IMPLEMENTATION
 *       #include "witness.h"
 *   Everywhere else just #include "witness.h".
 *
 *   Works from C99 and C++11 or later. The implementation compiles as either.
 *   Link: ws2_32 on Windows (automatic with MSVC; add -lws2_32 for MinGW),
 *         -pthread -lm on POSIX.
 *
 * SHAPE (C API; a thin C++ layer at the bottom adds witness::Json, witness::Value
 *        and std::function handlers)
 *
 *   if (witness_active(argc, argv)) {           // WITNESS_ADDR set or --witness passed
 *       witness_hello hello = {0};
 *       hello.name = "My Game"; hello.fps = 60; hello.width = 320; hello.height = 180;
 *       witness_handlers h = {0};
 *       h.reset = my_reset; h.step = my_step; h.input = my_input; h.snapshot = my_snapshot;
 *       if (!witness_connect(&hello, &h)) return 1;
 *       witness_run();                          // blocks, dispatching commands until quit
 *       witness_shutdown();
 *       return 0;
 *   }
 *   ... normal real-time loop (optionally witness_record_start() for replays) ...
 *
 *   Capabilities are advertised from the handlers you fill in. When Witness is not active,
 *   every function here is a cheap early-out: zero cost in normal play.
 *
 * THREADS: witness_log() and witness_audio_write() may be called from any thread once
 *   witness_connect() returned. Everything else belongs to the thread that calls
 *   witness_poll()/witness_run() (your main/sim thread).
 *
 * LICENSE: MIT. */
#ifndef WITNESS_H
#define WITNESS_H

#include <stddef.h>

#define WITNESS_PROTOCOL 1
#define WITNESS_VERSION "1.0.0"

#ifndef WITNESS_API
#define WITNESS_API
#endif

#if defined(__GNUC__) || defined(__clang__)
#define WITNESS_PRINTF(fmt_index, first_arg) __attribute__((format(printf, fmt_index, first_arg)))
#else
#define WITNESS_PRINTF(fmt_index, first_arg)
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------- JSON values (read) */

typedef enum witness_type {
    WITNESS_NULL, WITNESS_BOOL, WITNESS_NUMBER, WITNESS_STRING, WITNESS_ARRAY, WITNESS_OBJECT
} witness_type;

/* A parsed JSON value. Valid only during the handler call that received it. */
typedef struct witness_value {
    witness_type type;
    double number;                     /* NUMBER; BOOL as 0/1 */
    const char *string;                /* STRING: unescaped UTF-8, NUL-terminated */
    size_t length;                     /* STRING: bytes. ARRAY/OBJECT: child count */
    const char *key;                   /* member name when inside an OBJECT, else NULL */
    const struct witness_value *child; /* ARRAY/OBJECT: first child */
    const struct witness_value *next;  /* next sibling */
} witness_value;

/* All accessors are NULL-safe, so chains like witness_get(witness_get(v, "a"), "b") work. */
WITNESS_API const witness_value *witness_get(const witness_value *object, const char *key);
WITNESS_API const witness_value *witness_at(const witness_value *array, size_t index);
/* NUMBER, BOOL, or a STRING holding a number ("12.5"); otherwise def. */
WITNESS_API double witness_number(const witness_value *v, double def);
WITNESS_API long long witness_int(const witness_value *v, long long def);
WITNESS_API const char *witness_string(const witness_value *v, const char *def);
WITNESS_API int witness_bool(const witness_value *v, int def);

/* ---------------------------------------------------------------- JSON writer */

/* Streaming writer used for snapshots, call results, perf. Commas and nesting are handled
 * for you; unbalanced containers are closed automatically when your handler returns.
 * Doubles that are NaN/Inf are written as the strings "NaN", "Infinity", "-Infinity". */
typedef struct witness_json witness_json;

WITNESS_API void witness_json_begin_object(witness_json *w);
WITNESS_API void witness_json_end_object(witness_json *w);
WITNESS_API void witness_json_begin_array(witness_json *w);
WITNESS_API void witness_json_end_array(witness_json *w);
WITNESS_API void witness_json_key(witness_json *w, const char *key);
WITNESS_API void witness_json_null(witness_json *w);
WITNESS_API void witness_json_bool(witness_json *w, int v);
WITNESS_API void witness_json_int(witness_json *w, long long v);
WITNESS_API void witness_json_number(witness_json *w, double v);
WITNESS_API void witness_json_string(witness_json *w, const char *s);          /* NULL -> null */
WITNESS_API void witness_json_string_n(witness_json *w, const char *s, size_t n);
WITNESS_API void witness_json_raw(witness_json *w, const char *json);          /* pre-encoded value */
WITNESS_API void witness_json_vec2(witness_json *w, double x, double y);       /* [x, y] */
WITNESS_API void witness_json_vec3(witness_json *w, double x, double y, double z);
WITNESS_API void witness_json_base64(witness_json *w, const void *data, size_t n);
/* key + value in one call */
WITNESS_API void witness_json_field_int(witness_json *w, const char *key, long long v);
WITNESS_API void witness_json_field_number(witness_json *w, const char *key, double v);
WITNESS_API void witness_json_field_string(witness_json *w, const char *key, const char *s);
WITNESS_API void witness_json_field_bool(witness_json *w, const char *key, int v);

/* ---------------------------------------------------------------- input events */

typedef enum witness_event_type {
    WITNESS_EV_KEY, WITNESS_EV_MOUSE, WITNESS_EV_WHEEL, WITNESS_EV_TEXT,
    WITNESS_EV_ACTION, WITNESS_EV_PAD, WITNESS_EV_AXIS, WITNESS_EV_OTHER,
    WITNESS_EV_TOUCH  /* appended last: the values above keep their numbers */
} witness_event_type;

typedef enum witness_touch_phase {
    WITNESS_TOUCH_DOWN, WITNESS_TOUCH_MOVE, WITNESS_TOUCH_UP,
    WITNESS_TOUCH_CANCEL  /* appended last: the system ended the touch (SDL_EVENT_FINGER_CANCELED).
                             Ends it like UP (finger no longer down, id freed), but it is not a
                             completed tap; games that don't care may treat it as UP. */
} witness_touch_phase;

typedef struct witness_event {
    witness_event_type type;
    long long frame;  /* frame at whose start the event applies */
    char name[32];    /* KEY: key name ("a", "space", "left"); ACTION: action; PAD: button;
                         AXIS: axis; OTHER: the unrecognised "type" string */
    int down;         /* 1 pressed, 0 released, -1 not given (mouse move, axis, text).
                         TOUCH: 1 on down, 0 on up or cancel, -1 on move */
    int has_pos;      /* MOUSE: 1 when x/y are set. TOUCH: always 1 */
    double x, y;      /* MOUSE / TOUCH: logical pixels, top-left origin */
    int button;       /* MOUSE: 0 left, 1 middle, 2 right; -1 when not a button event */
    double dx, dy;    /* WHEEL */
    double value;     /* AXIS: -1..1 */
    char text[128];   /* TEXT: UTF-8 */
    int id;           /* TOUCH: finger, 0 = first finger down (stable from down to up) */
    int phase;        /* TOUCH: WITNESS_TOUCH_DOWN / _MOVE / _UP / _CANCEL */
    double pressure;  /* TOUCH: 0..1, 1 when not given (when recording, 0 also means not given) */
    int from_touch;   /* MOUSE: 1 = synthesized from finger 0 (like SDL_TOUCH_MOUSEID); skip it if
                         the game also handles the TOUCH event. Never recorded. */
} witness_event;

/* Canonical Witness key name from any common spelling: "Return" -> "enter",
 * "Left Shift" -> "shift", "ArrowUp" -> "up", "Esc" -> "escape", "A" -> "a".
 * Feed it SDL_GetKeyName(), browser KeyboardEvent.key, etc. Returns out. */
WITNESS_API const char *witness_key_normalize(const char *name, char *out, size_t out_size);

/* ---------------------------------------------------------------- handlers & hello */

typedef struct witness_image {
    const unsigned char *rgba; /* 8-bit RGBA pixels */
    int width, height;
    int stride;                /* bytes per row; 0 = width * 4 */
    int bottom_up;             /* 1 if row 0 is the BOTTOM row (glReadPixels); flipped for you */
} witness_image;

typedef struct witness_handlers {
    void *user; /* passed back to every handler */
    /* Return the game to a deterministic initial state. scene/params may be NULL.
     * Return 0 (optionally after witness_error()) to fail. */
    int (*reset)(void *user, long long seed, const char *scene, const witness_value *params);
    /* REQUIRED. Advance exactly one fixed frame of dt seconds. Due input was already
     * delivered through input() (and is available from witness_frame_events()). */
    void (*step)(void *user, double dt);
    /* Deliver one input event through the game's normal input path. Optional: games that
     * poll can use witness_key_down() / witness_mouse() / witness_frame_events() instead. */
    void (*input)(void *user, const witness_event *event);
    /* REQUIRED. Write the state as ONE JSON object. paths may be NULL (an optional filter). */
    void (*snapshot)(void *user, witness_json *out, const witness_value *paths);
    /* Fill *out with the current frame. The pixels must stay valid until the call returns. */
    int (*screenshot)(void *user, witness_image *out);
    /* Game-specific command. Write ONE JSON value into result (nothing = null).
     * Return 0 for unknown names or failures (use witness_error() for the message). */
    int (*call)(void *user, const char *name, const witness_value *args, witness_json *result);
    /* Optional: evaluate an expression in the game's script language; write ONE value. */
    int (*eval)(void *user, const char *expr, witness_json *value);
    /* Optional: write timing FIELDS (keys + values), e.g. "frame_ms", "counts". */
    void (*perf)(void *user, witness_json *out);
} witness_handlers;

typedef struct witness_call_info {
    const char *name; /* "teleport" */
    const char *args; /* "x y" (free text, may be NULL) */
    const char *help; /* may be NULL */
} witness_call_info;

/* Zero-initialise, then set what you have. Unset fields get defaults. */
typedef struct witness_hello {
    const char *name;                /* default "game" */
    const char *engine;              /* e.g. "custom C++/SDL3" */
    const char *language;            /* default "c++" */
    int fps;                         /* default 60; the default step dt is 1/fps */
    int width, height;               /* logical size */
    const witness_call_info *calls;  /* advertised custom commands */
    int call_count;
    const char *const *keys;         /* keys the game actually uses (optional) */
    int key_count;
    int audio_sample_rate;           /* > 0 enables the "audio" capability */
    int audio_channels;              /* default 1 */
    int touch;                       /* 1 = the game handles WITNESS_EV_TOUCH itself: don't also deliver
                                        finger 0 as mouse events (the default mouse fallback) */
} witness_hello;

/* ---------------------------------------------------------------- lifecycle */

/* True when WITNESS_ADDR is set or "--witness" is in argv (argv may be NULL). */
WITNESS_API int witness_active(int argc, char **argv);
/* Connect to WITNESS_ADDR (default 127.0.0.1:7357, retrying for up to 10 s) and send the
 * hello. Copies *handlers; hello strings are only read during the call. 1 = connected. */
WITNESS_API int witness_connect(const witness_hello *hello, const witness_handlers *handlers);
/* Process commands. timeout_ms < 0 blocks until at least one command was handled.
 * Returns 1 while connected, 0 after "quit" or a disconnect (then exit the game). */
WITNESS_API int witness_poll(int timeout_ms);
/* witness_poll(-1) until it returns 0. */
WITNESS_API void witness_run(void);
WITNESS_API int witness_connected(void);
/* Close the connection, stop recording, free everything. Safe to call anytime. */
WITNESS_API void witness_shutdown(void);
/* From inside a handler: make the current command fail with this message. */
WITNESS_API void witness_error(const char *fmt, ...) WITNESS_PRINTF(1, 2);

/* ---------------------------------------------------------------- simulation info */

WITNESS_API long long witness_frame(void); /* frames stepped since reset */
WITNESS_API double witness_time(void);     /* simulated seconds since reset */
/* 0 inside step() for a frame nobody will see (a step sent with "draw": "last": every frame but its last), else 1.
 * A game that renders every step may skip rendering then; the simulation must not depend on it (docs/PROTOCOL.md §3). */
WITNESS_API int witness_drawing(void);
/* Seed your RNGs with this: the reset seed in witness mode, the recorded seed while
 * recording (WITNESS_SEED or the clock), else a clock-based seed chosen once. */
WITNESS_API long long witness_seed(void);

/* Pull-style input (alternative to the input handler), valid during step(): */
WITNESS_API const witness_event *witness_frame_events(int *count);
WITNESS_API int witness_key_down(const char *name);
/* Mouse position and button bitmask (bit 0 left, 1 middle, 2 right). Any pointer may be NULL. */
WITNESS_API void witness_mouse(double *x, double *y, int *buttons);
/* 1 while finger id (0..9) is down, with its position in *x / *y (either may be NULL). */
WITNESS_API int witness_touch(int id, double *x, double *y);

/* ---------------------------------------------------------------- logs */

typedef enum witness_level { WITNESS_INFO, WITNESS_WARN, WITNESS_ERROR } witness_level;
/* Buffered and returned on "logs". WITNESS_ERROR lines fail tests. No-op when inactive. */
WITNESS_API void witness_log(witness_level level, const char *fmt, ...) WITNESS_PRINTF(2, 3);

/* ---------------------------------------------------------------- audio capture */

/* In witness mode, render your mixer once per step into a buffer and hand it over here
 * (interleaved, hello.audio_channels channels, hello.audio_sample_rate Hz). */
WITNESS_API void witness_audio_write(const float *interleaved, int frames);
WITNESS_API void witness_audio_write_s16(const short *interleaved, int frames);
/* Inside step(dt): how many sample frames to render so audio tracks simulated time exactly
 * (no drift, even with irregular replay dts). */
WITNESS_API int witness_audio_frames_for_step(double dt);

/* ---------------------------------------------------------------- sound events */

/* Announce that the game started a sound ("jump", "coin"): sent at once as a protocol "sound"
 * event stamped with the current frame. Call from the sim thread (e.g. inside step()).
 * No-op when not connected (normal play, recording). */
WITNESS_API void witness_sound(const char *name);
/* The same with a volume (0..1; < 0 = not given) and a screen position in pixels (has_pos 0 = not given). */
WITNESS_API void witness_sound_ex(const char *name, double volume, int has_pos, double x, double y);

/* ---------------------------------------------------------------- replay recording */

/* Normal play only: if WITNESS_RECORD=<file.jsonl> is set (and Witness is not active),
 * create the file (and its folders) and write the header. Returns 1 when recording. */
WITNESS_API int witness_record_start(const char *game_name, int fps);
/* The same with the seed the world really used and an optional params object (raw JSON, e.g. {"scene":"town"}: what
 * the game's reset needs to rebuild this start), written to the header as "seed" and "params". Starts a fresh file
 * if a recording is already open (a new playthrough). Returns 1 when recording. */
WITNESS_API int witness_record_begin(const char *game_name, int fps, long long seed, const char *params_json);
WITNESS_API int witness_recording(void);
/* Queue input for the current frame (call from your event pump). Pressing F8 writes a mark. */
WITNESS_API void witness_record_event(const witness_event *event);
WITNESS_API void witness_record_key(const char *key, int down);
WITNESS_API void witness_record_mouse(double x, double y, int button, int down); /* button -1 = move */
/* A finger: id 0 = first finger, phase WITNESS_TOUCH_DOWN / _MOVE / _UP / _CANCEL, logical pixels
 * (convert SDL's normalized 0..1 finger coordinates). Record SDL_EVENT_FINGER_CANCELED as
 * WITNESS_TOUCH_CANCEL: it replays as a cancel, not an up. Don't also record the mouse events the
 * platform synthesizes from touch (SDL: which == SDL_TOUCH_MOUSEID); replay recreates them.
 * witness_record_touch records no pressure (replays use 1); witness_record_touch_ex also records
 * the finger's pressure, 0..1 (SDL's event.tfinger.pressure); pressure <= 0 means not given. */
WITNESS_API void witness_record_touch(int id, double x, double y, int phase);
WITNESS_API void witness_record_touch_ex(int id, double x, double y, int phase, double pressure);
/* End of frame: write one line with this frame's dt and queued events (flushed every frame,
 * so a crash keeps the replay). */
WITNESS_API void witness_record_frame(double dt);
WITNESS_API void witness_mark(const char *label);
WITNESS_API void witness_record_stop(void);

/* ---------------------------------------------------------------- misc helpers */

/* Writes base64 of data into out (needs WITNESS_BASE64_SIZE(n) bytes incl. NUL). */
#define WITNESS_BASE64_SIZE(n) ((((n) + 2) / 3) * 4 + 1)
WITNESS_API size_t witness_base64_encode(const void *data, size_t n, char *out);

/* ---------------------------------------------------------------- web (Emscripten) builds */

/* Built with emcc, witness.h uses no sockets: it talks to the CLI through witness_emscripten.js (link it with
 * --pre-js), which holds a WebSocket and calls the functions below. The game's code doesn't change, except that in
 * witness mode it must not start its own main loop (see GUIDE.md "Web (Emscripten) builds"):
 *   witness_active()  1 when the page URL has ?witness=host:port (the CLI adds it)
 *   witness_connect() starts connecting and returns 1 at once (the hello waits until the socket is open)
 *   witness_run()     returns to the browser and keeps the runtime alive (emscripten_exit_with_live_runtime):
 *                     from then on every command runs inside witness_emscripten_recv, called by the shim
 * Define WITNESS_EMSCRIPTEN_SOCKETS to keep the socket code instead (emcc -sPROXY_POSIX_SOCKETS builds). */
#if defined(__EMSCRIPTEN__) && !defined(WITNESS_EMSCRIPTEN_SOCKETS) && !defined(WITNESS_WEB_BRIDGE)
#define WITNESS_WEB_BRIDGE 1
#endif
#ifdef WITNESS_WEB_BRIDGE
/* Called from witness_emscripten.js only. inbuf: room for size more input bytes; recv: they were written there
 * (complete lines are handled now); closed: the WebSocket closed. */
WITNESS_API char *witness_emscripten_inbuf(int size);
WITNESS_API int witness_emscripten_recv(int len);
WITNESS_API void witness_emscripten_closed(void);
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ================================================================= C++ convenience layer */
#if defined(__cplusplus) && !defined(WITNESS_NO_CPP)
#include <functional>
#include <string>

namespace witness {

/* Fluent wrapper over witness_json:
 *   j.begin_object().field("score", score).key("pos").vec(x, y).end_object(); */
class Json {
public:
    explicit Json(witness_json *w) : w_(w) {}
    Json &begin_object() { witness_json_begin_object(w_); return *this; }
    Json &end_object() { witness_json_end_object(w_); return *this; }
    Json &begin_array() { witness_json_begin_array(w_); return *this; }
    Json &end_array() { witness_json_end_array(w_); return *this; }
    Json &key(const char *k) { witness_json_key(w_, k); return *this; }
    Json &key(const std::string &k) { witness_json_key(w_, k.c_str()); return *this; }
    Json &value(std::nullptr_t) { witness_json_null(w_); return *this; }
    Json &value(bool v) { witness_json_bool(w_, v ? 1 : 0); return *this; }
    Json &value(int v) { witness_json_int(w_, v); return *this; }
    Json &value(long v) { witness_json_int(w_, v); return *this; }
    Json &value(long long v) { witness_json_int(w_, v); return *this; }
    Json &value(unsigned v) { witness_json_int(w_, static_cast<long long>(v)); return *this; }
    Json &value(unsigned long v) { witness_json_number(w_, static_cast<double>(v)); return *this; }
    Json &value(unsigned long long v) { witness_json_number(w_, static_cast<double>(v)); return *this; }
    Json &value(float v) { witness_json_number(w_, static_cast<double>(v)); return *this; }
    Json &value(double v) { witness_json_number(w_, v); return *this; }
    Json &value(const char *s) { witness_json_string(w_, s); return *this; }
    Json &value(const std::string &s) { witness_json_string_n(w_, s.data(), s.size()); return *this; }
    template <class T> Json &field(const char *k, const T &v) { key(k); return value(v); }
    Json &vec(double x, double y) { witness_json_vec2(w_, x, y); return *this; }
    Json &vec(double x, double y, double z) { witness_json_vec3(w_, x, y, z); return *this; }
    Json &raw(const char *json) { witness_json_raw(w_, json); return *this; }
    witness_json *c() const { return w_; }
private:
    witness_json *w_;
};

/* Read-only view over a witness_value: v["events"][0]["key"].str() */
class Value {
public:
    Value(const witness_value *v = nullptr) : v_(v) {}
    Value operator[](const char *k) const { return Value(witness_get(v_, k)); }
    Value operator[](int i) const { return Value(i < 0 ? nullptr : witness_at(v_, static_cast<size_t>(i))); }
    Value at(size_t i) const { return Value(witness_at(v_, i)); }
    bool exists() const { return v_ != nullptr; }
    witness_type type() const { return v_ ? v_->type : WITNESS_NULL; }
    size_t size() const { return v_ && (v_->type == WITNESS_ARRAY || v_->type == WITNESS_OBJECT) ? v_->length : 0; }
    double num(double def = 0) const { return witness_number(v_, def); }
    long long integer(long long def = 0) const { return witness_int(v_, def); }
    const char *str(const char *def = "") const { return witness_string(v_, def); }
    bool boolean(bool def = false) const { return witness_bool(v_, def ? 1 : 0) != 0; }
    const witness_value *c() const { return v_; }
private:
    const witness_value *v_;
};

/* std::function handlers. Leave a member empty if the game doesn't support it. To fail a
 * command, call witness::fail("message") (or throw, if exceptions are enabled). */
struct Handlers {
    std::function<void(long long seed, const char *scene, Value params)> reset;
    std::function<void(double dt)> step;                                   /* required */
    std::function<void(const witness_event &event)> input;
    std::function<void(Json &state)> snapshot;                             /* required */
    std::function<bool(witness_image &out)> screenshot;
    std::function<void(const char *name, Value args, Json &result)> call;
    std::function<void(const char *expr, Json &value)> eval;
    std::function<void(Json &fields)> perf;
};

inline void fail(const char *message) { witness_error("%s", message ? message : "failed"); }
inline void fail(const std::string &message) { witness_error("%s", message.c_str()); }

/* Sound events: witness::sound("jump"), sound("jump", 0.8), sound("jump", 0.8, x, y). */
inline void sound(const char *name) { witness_sound(name); }
inline void sound(const char *name, double volume) { witness_sound_ex(name, volume, 0, 0, 0); }
inline void sound(const char *name, double volume, double x, double y) { witness_sound_ex(name, volume, 1, x, y); }

namespace detail {
inline Handlers &handlers() { static Handlers h; return h; }
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
template <class F> inline bool guard(F f) {
    try { f(); } catch (const std::exception &e) { fail(e.what()); return false; }
    catch (...) { fail("unknown C++ exception"); return false; }
    return true;
}
#else
template <class F> inline bool guard(F f) { f(); return true; }
#endif
inline int reset(void *, long long seed, const char *scene, const witness_value *params) {
    return guard([&] { handlers().reset(seed, scene, Value(params)); }) ? 1 : 0;
}
inline void step(void *, double dt) { guard([&] { handlers().step(dt); }); }
inline void input(void *, const witness_event *e) { guard([&] { handlers().input(*e); }); }
inline void snapshot(void *, witness_json *w, const witness_value *) {
    Json j(w);
    guard([&] { handlers().snapshot(j); });
}
inline int screenshot(void *, witness_image *out) {
    bool ok = false;
    guard([&] { ok = handlers().screenshot(*out); });
    return ok ? 1 : 0;
}
inline int call(void *, const char *name, const witness_value *args, witness_json *w) {
    Json j(w);
    return guard([&] { handlers().call(name, Value(args), j); }) ? 1 : 0;
}
inline int eval(void *, const char *expr, witness_json *w) {
    Json j(w);
    return guard([&] { handlers().eval(expr, j); }) ? 1 : 0;
}
inline void perf(void *, witness_json *w) {
    Json j(w);
    guard([&] { handlers().perf(j); });
}
} /* namespace detail */

/* Connect with std::function handlers (stored internally; one connection per process). */
inline bool connect(const witness_hello &hello, const Handlers &h) {
    detail::handlers() = h;
    witness_handlers c = witness_handlers();
    if (h.reset) c.reset = detail::reset;
    if (h.step) c.step = detail::step;
    if (h.input) c.input = detail::input;
    if (h.snapshot) c.snapshot = detail::snapshot;
    if (h.screenshot) c.screenshot = detail::screenshot;
    if (h.call) c.call = detail::call;
    if (h.eval) c.eval = detail::eval;
    if (h.perf) c.perf = detail::perf;
    return witness_connect(&hello, &c) != 0;
}

inline bool active(int argc = 0, char **argv = nullptr) { return witness_active(argc, argv) != 0; }

} /* namespace witness */
#endif /* __cplusplus */

#endif /* WITNESS_H */

/* ================================================================= implementation */
#ifdef WITNESS_IMPLEMENTATION
#ifndef WITNESS_IMPLEMENTATION_DONE
#define WITNESS_IMPLEMENTATION_DONE

#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L /* effective only if no system header came first */
#endif

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <locale.h>

#ifdef WITNESS_WEB_BRIDGE
/* web builds: no sockets; protocol lines go through witness_emscripten.js (EM_JS functions below) */
#include <emscripten.h>
#ifdef _WIN32 /* only Witness's own native test build of the bridge (a stub emscripten.h) */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#endif
typedef int witness__socket;
#define WITNESS__NO_SOCKET (-1)
#elif defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifdef _MSC_VER
#pragma comment(lib, "ws2_32")
#include <crtdbg.h>
#endif
typedef SOCKET witness__socket;
#define WITNESS__NO_SOCKET INVALID_SOCKET
#define witness__closesocket closesocket
#else
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <poll.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
typedef int witness__socket;
#define WITNESS__NO_SOCKET (-1)
#define witness__closesocket close
#endif

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define WITNESS__MAX_DEPTH 64
#define WITNESS__MAX_KEYS 64
#define WITNESS__MAX_TOUCHES 10
#define WITNESS__MAX_LOGS 4096
#define WITNESS__AUDIO_MAX_SECONDS 120

#ifdef __cplusplus
#define WITNESS__CAST(T, x) static_cast<T>(x)
#else
#define WITNESS__CAST(T, x) ((T)(x))
#endif

/* ---------------------------------------------------------------- small utilities */

static void *witness__grow(void *p, size_t *cap, size_t need, size_t elem) {
    size_t c = *cap ? *cap : 16;
    void *q;
    if (need <= *cap) return p;
    while (c < need) c *= 2;
    q = realloc(p, c * elem);
    if (!q) return NULL;
    *cap = c;
    return q;
}

static void witness__copy(char *dst, size_t size, const char *src) {
    size_t i = 0;
    if (!size) return;
    if (src) for (; src[i] && i + 1 < size; i++) dst[i] = src[i];
    /* never cut a UTF-8 sequence in half */
    if (src && src[i]) while (i > 0 && (WITNESS__CAST(unsigned char, src[i]) & 0xC0) == 0x80) i--;
    dst[i] = 0;
}

static int witness__getenv(const char *name, char *out, size_t size) {
#ifdef _WIN32
    DWORD n = GetEnvironmentVariableA(name, out, WITNESS__CAST(DWORD, size));
    if (n == 0 || n >= size) { if (size) out[0] = 0; return 0; }
    return 1;
#else
    const char *v = getenv(name);
    if (!v || !*v || strlen(v) >= size) { if (size) out[0] = 0; return 0; }
    witness__copy(out, size, v);
    return 1;
#endif
}

#ifndef WITNESS_WEB_BRIDGE /* web builds never block or wait */
static void witness__sleep_ms(int ms) {
#ifdef _WIN32
    Sleep(WITNESS__CAST(DWORD, ms));
#else
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
#endif
}

static double witness__now_ms(void) {
#ifdef _WIN32
    return WITNESS__CAST(double, GetTickCount64());
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}
#endif

/* Locale-proof strtod: JSON always uses '.', the C locale of a game may not. */
static double witness__strtod(const char *s, size_t n, int *ok) {
    char buf[96];
    char *end = NULL;
    const char *dp = localeconv()->decimal_point;
    size_t i;
    double v;
    *ok = 0;
    if (n == 0 || n >= sizeof buf) return 0;
    for (i = 0; i < n; i++) buf[i] = (s[i] == '.' && dp && dp[0]) ? dp[0] : s[i];
    buf[n] = 0;
    v = strtod(buf, &end);
    *ok = end == buf + n;
    return v;
}

static size_t witness__fmt_double(char *buf, size_t size, double v) {
    const char *dp = localeconv()->decimal_point;
    int n, ok = 0;
    size_t i;
    n = snprintf(buf, size, "%.15g", v);
    if (n > 0 && WITNESS__CAST(size_t, n) < size) {
        if (dp && dp[0] && dp[0] != '.') for (i = 0; buf[i]; i++) if (buf[i] == dp[0]) buf[i] = '.';
        if (witness__strtod(buf, WITNESS__CAST(size_t, n), &ok) == v && ok) return WITNESS__CAST(size_t, n);
    }
    n = snprintf(buf, size, "%.17g", v); /* exact round trip */
    if (dp && dp[0] && dp[0] != '.') for (i = 0; buf[i]; i++) if (buf[i] == dp[0]) buf[i] = '.';
    return n > 0 ? WITNESS__CAST(size_t, n) : 0;
}

size_t witness_base64_encode(const void *data, size_t n, char *out) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const unsigned char *p = WITNESS__CAST(const unsigned char *, data);
    size_t i = 0, o = 0;
    for (; i + 2 < n; i += 3) {
        unsigned v = (unsigned)p[i] << 16 | (unsigned)p[i + 1] << 8 | p[i + 2];
        out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63]; out[o++] = T[(v >> 6) & 63]; out[o++] = T[v & 63];
    }
    if (i < n) {
        unsigned v = (unsigned)p[i] << 16 | (i + 1 < n ? (unsigned)p[i + 1] << 8 : 0u);
        out[o++] = T[v >> 18]; out[o++] = T[(v >> 12) & 63];
        out[o++] = i + 1 < n ? T[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    out[o] = 0;
    return o;
}

/* ---------------------------------------------------------------- JSON writer */

struct witness_json {
    char *buf;
    size_t len, cap;
    int depth;
    int after_key;
    int failed;
    unsigned count[WITNESS__MAX_DEPTH];
    char kind[WITNESS__MAX_DEPTH]; /* '{' or '[' */
};

static int witness__jw_reserve(witness_json *w, size_t extra) {
    char *p;
    if (w->failed) return 0;
    p = WITNESS__CAST(char *, witness__grow(w->buf, &w->cap, w->len + extra + 1, 1));
    if (!p) { w->failed = 1; return 0; }
    w->buf = p;
    return 1;
}

static void witness__jw_put(witness_json *w, const char *s, size_t n) {
    if (!witness__jw_reserve(w, n)) return;
    memcpy(w->buf + w->len, s, n);
    w->len += n;
    w->buf[w->len] = 0;
}

static void witness__jw_putc(witness_json *w, char c) { witness__jw_put(w, &c, 1); }

static void witness__jw_clear(witness_json *w) {
    w->len = 0; w->depth = 0; w->after_key = 0; w->failed = 0;
    if (w->buf) w->buf[0] = 0;
}

/* comma management before any value or key */
static void witness__jw_pre(witness_json *w) {
    if (w->after_key) { w->after_key = 0; return; }
    if (w->depth > 0 && w->count[w->depth - 1]++) witness__jw_putc(w, ',');
}

static void witness__jw_str(witness_json *w, const char *s, size_t n) {
    static const char hex[] = "0123456789abcdef";
    size_t i, run = 0;
    witness__jw_putc(w, '"');
    for (i = 0; i < n; i++) {
        unsigned char c = WITNESS__CAST(unsigned char, s[i]);
        const char *esc = NULL;
        char u[6];
        if (c == '"') esc = "\\\"";
        else if (c == '\\') esc = "\\\\";
        else if (c == '\n') esc = "\\n";
        else if (c == '\r') esc = "\\r";
        else if (c == '\t') esc = "\\t";
        else if (c < 0x20 || c == 0x7f) {
            u[0] = '\\'; u[1] = 'u'; u[2] = '0'; u[3] = '0'; u[4] = hex[c >> 4]; u[5] = hex[c & 15];
        } else continue;
        if (i > run) witness__jw_put(w, s + run, i - run);
        if (esc) witness__jw_put(w, esc, 2); else witness__jw_put(w, u, 6);
        run = i + 1;
    }
    if (n > run) witness__jw_put(w, s + run, n - run);
    witness__jw_putc(w, '"');
}

static void witness__jw_open(witness_json *w, char kind) {
    witness__jw_pre(w);
    witness__jw_putc(w, kind);
    if (w->depth >= WITNESS__MAX_DEPTH) { w->failed = 1; return; }
    w->kind[w->depth] = kind;
    w->count[w->depth] = 0;
    w->depth++;
}

static void witness__jw_close(witness_json *w, char kind) {
    if (w->depth <= 0 || w->kind[w->depth - 1] != kind) return; /* tolerate stray ends */
    if (w->after_key) { w->after_key = 0; witness__jw_put(w, "null", 4); }
    w->depth--;
    witness__jw_putc(w, kind == '{' ? '}' : ']');
}

/* close everything a handler left open, down to `depth` */
static void witness__jw_close_to(witness_json *w, int depth) {
    if (w->after_key) { w->after_key = 0; witness__jw_put(w, "null", 4); }
    while (w->depth > depth) witness__jw_close(w, w->kind[w->depth - 1]);
}

void witness_json_begin_object(witness_json *w) { witness__jw_open(w, '{'); }
void witness_json_end_object(witness_json *w) { witness__jw_close(w, '{'); }
void witness_json_begin_array(witness_json *w) { witness__jw_open(w, '['); }
void witness_json_end_array(witness_json *w) { witness__jw_close(w, '['); }

void witness_json_key(witness_json *w, const char *key) {
    if (w->depth <= 0 || w->kind[w->depth - 1] != '{') return;
    if (w->after_key) { w->after_key = 0; witness__jw_put(w, "null", 4); }
    witness__jw_pre(w);
    witness__jw_str(w, key ? key : "", key ? strlen(key) : 0);
    witness__jw_putc(w, ':');
    w->after_key = 1;
}

void witness_json_null(witness_json *w) { witness__jw_pre(w); witness__jw_put(w, "null", 4); }
void witness_json_bool(witness_json *w, int v) { witness__jw_pre(w); if (v) witness__jw_put(w, "true", 4); else witness__jw_put(w, "false", 5); }

void witness_json_int(witness_json *w, long long v) {
    char b[32];
    int n = snprintf(b, sizeof b, "%lld", v);
    witness__jw_pre(w);
    witness__jw_put(w, b, n > 0 ? WITNESS__CAST(size_t, n) : 0);
}

void witness_json_number(witness_json *w, double v) {
    char b[40];
    if (v != v) { witness__jw_pre(w); witness__jw_put(w, "\"NaN\"", 5); return; }
    if (v > 1.7976931348623157e308) { witness__jw_pre(w); witness__jw_put(w, "\"Infinity\"", 10); return; }
    if (v < -1.7976931348623157e308) { witness__jw_pre(w); witness__jw_put(w, "\"-Infinity\"", 11); return; }
    witness__jw_pre(w);
    witness__jw_put(w, b, witness__fmt_double(b, sizeof b, v));
}

void witness_json_string(witness_json *w, const char *s) {
    if (!s) { witness_json_null(w); return; }
    witness_json_string_n(w, s, strlen(s));
}

void witness_json_string_n(witness_json *w, const char *s, size_t n) {
    witness__jw_pre(w);
    witness__jw_str(w, s ? s : "", s ? n : 0);
}

void witness_json_raw(witness_json *w, const char *json) {
    witness__jw_pre(w);
    if (!json || !*json) { witness__jw_put(w, "null", 4); return; }
    witness__jw_put(w, json, strlen(json));
}

void witness_json_vec2(witness_json *w, double x, double y) {
    witness_json_begin_array(w); witness_json_number(w, x); witness_json_number(w, y); witness_json_end_array(w);
}

void witness_json_vec3(witness_json *w, double x, double y, double z) {
    witness_json_begin_array(w); witness_json_number(w, x); witness_json_number(w, y); witness_json_number(w, z);
    witness_json_end_array(w);
}

void witness_json_base64(witness_json *w, const void *data, size_t n) {
    size_t need = WITNESS_BASE64_SIZE(n) + 2;
    witness__jw_pre(w);
    if (!witness__jw_reserve(w, need)) return;
    w->buf[w->len++] = '"';
    w->len += witness_base64_encode(data, n, w->buf + w->len);
    w->buf[w->len++] = '"';
    w->buf[w->len] = 0;
}

void witness_json_field_int(witness_json *w, const char *key, long long v) { witness_json_key(w, key); witness_json_int(w, v); }
void witness_json_field_number(witness_json *w, const char *key, double v) { witness_json_key(w, key); witness_json_number(w, v); }
void witness_json_field_string(witness_json *w, const char *key, const char *s) { witness_json_key(w, key); witness_json_string(w, s); }
void witness_json_field_bool(witness_json *w, const char *key, int v) { witness_json_key(w, key); witness_json_bool(w, v); }

/* ---------------------------------------------------------------- JSON reader */

/* Nodes are built in a growable array with index links, then published as a pointer tree. */
typedef struct witness__node {
    witness_type type;
    double number;
    const char *string;
    size_t length;
    const char *key;
    long child, next;
} witness__node;

typedef struct witness__parser {
    char *p;
    char *end;
    witness__node *nodes;
    size_t count, cap;
    int failed;
} witness__parser;

static void witness__skip_ws(witness__parser *ps) {
    while (ps->p < ps->end && (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r')) ps->p++;
}

static long witness__new_node(witness__parser *ps, witness_type t) {
    witness__node *n = WITNESS__CAST(witness__node *, witness__grow(ps->nodes, &ps->cap, ps->count + 1, sizeof(witness__node)));
    if (!n) { ps->failed = 1; return -1; }
    ps->nodes = n;
    memset(&n[ps->count], 0, sizeof(witness__node));
    n[ps->count].type = t;
    n[ps->count].child = n[ps->count].next = -1;
    return WITNESS__CAST(long, ps->count++);
}

static int witness__hex4(const char *s, unsigned *out) {
    unsigned v = 0;
    int i;
    for (i = 0; i < 4; i++) {
        char c = s[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= WITNESS__CAST(unsigned, c - '0');
        else if (c >= 'a' && c <= 'f') v |= WITNESS__CAST(unsigned, c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= WITNESS__CAST(unsigned, c - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

/* Unescape a string in place (the output never outruns the input). ps->p is just past '"'. */
static const char *witness__parse_string(witness__parser *ps, size_t *len) {
    char *start = ps->p, *dst = ps->p;
    while (ps->p < ps->end) {
        unsigned char c = WITNESS__CAST(unsigned char, *ps->p++);
        if (c == '"') { *dst = 0; *len = WITNESS__CAST(size_t, dst - start); return start; }
        if (c < 0x20) break;
        if (c != '\\') { *dst++ = WITNESS__CAST(char, c); continue; }
        if (ps->p >= ps->end) break;
        c = WITNESS__CAST(unsigned char, *ps->p++);
        switch (c) {
            case '"': *dst++ = '"'; break;
            case '\\': *dst++ = '\\'; break;
            case '/': *dst++ = '/'; break;
            case 'b': *dst++ = '\b'; break;
            case 'f': *dst++ = '\f'; break;
            case 'n': *dst++ = '\n'; break;
            case 'r': *dst++ = '\r'; break;
            case 't': *dst++ = '\t'; break;
            case 'u': {
                unsigned cp, lo;
                if (ps->end - ps->p < 4 || !witness__hex4(ps->p, &cp)) goto bad;
                ps->p += 4;
                if (cp >= 0xD800 && cp <= 0xDBFF && ps->end - ps->p >= 6 && ps->p[0] == '\\' && ps->p[1] == 'u' &&
                    witness__hex4(ps->p + 2, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    ps->p += 6;
                } else if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD; /* lone surrogate */
                if (cp < 0x80) *dst++ = WITNESS__CAST(char, cp);
                else if (cp < 0x800) { *dst++ = WITNESS__CAST(char, 0xC0 | (cp >> 6)); *dst++ = WITNESS__CAST(char, 0x80 | (cp & 63)); }
                else if (cp < 0x10000) {
                    *dst++ = WITNESS__CAST(char, 0xE0 | (cp >> 12)); *dst++ = WITNESS__CAST(char, 0x80 | ((cp >> 6) & 63));
                    *dst++ = WITNESS__CAST(char, 0x80 | (cp & 63));
                } else {
                    *dst++ = WITNESS__CAST(char, 0xF0 | (cp >> 18)); *dst++ = WITNESS__CAST(char, 0x80 | ((cp >> 12) & 63));
                    *dst++ = WITNESS__CAST(char, 0x80 | ((cp >> 6) & 63)); *dst++ = WITNESS__CAST(char, 0x80 | (cp & 63));
                }
                break;
            }
            default: goto bad;
        }
    }
bad:
    ps->failed = 1;
    return NULL;
}

static long witness__parse_value(witness__parser *ps, int depth);

static long witness__parse_container(witness__parser *ps, int depth, int is_object) {
    long self = witness__new_node(ps, is_object ? WITNESS_OBJECT : WITNESS_ARRAY), last = -1;
    char close = is_object ? '}' : ']';
    if (self < 0) return -1;
    if (depth > WITNESS__MAX_DEPTH) { ps->failed = 1; return -1; }
    ps->p++; /* past '{' or '[' */
    witness__skip_ws(ps);
    if (ps->p < ps->end && *ps->p == close) { ps->p++; return self; }
    for (;;) {
        const char *key = NULL;
        long child;
        witness__skip_ws(ps);
        if (is_object) {
            size_t klen;
            if (ps->p >= ps->end || *ps->p != '"') { ps->failed = 1; return -1; }
            ps->p++;
            key = witness__parse_string(ps, &klen);
            if (!key) return -1;
            witness__skip_ws(ps);
            if (ps->p >= ps->end || *ps->p != ':') { ps->failed = 1; return -1; }
            ps->p++;
        }
        child = witness__parse_value(ps, depth + 1);
        if (child < 0) return -1;
        ps->nodes[child].key = key;
        if (last < 0) ps->nodes[self].child = child; else ps->nodes[last].next = child;
        last = child;
        ps->nodes[self].length++;
        witness__skip_ws(ps);
        if (ps->p < ps->end && *ps->p == ',') { ps->p++; continue; }
        if (ps->p < ps->end && *ps->p == close) { ps->p++; return self; }
        ps->failed = 1;
        return -1;
    }
}

static long witness__parse_value(witness__parser *ps, int depth) {
    long n;
    witness__skip_ws(ps);
    if (ps->p >= ps->end) { ps->failed = 1; return -1; }
    switch (*ps->p) {
        case '{': return witness__parse_container(ps, depth, 1);
        case '[': return witness__parse_container(ps, depth, 0);
        case '"': {
            size_t len;
            const char *s;
            ps->p++;
            s = witness__parse_string(ps, &len);
            if (!s) return -1;
            n = witness__new_node(ps, WITNESS_STRING);
            if (n < 0) return -1;
            ps->nodes[n].string = s;
            ps->nodes[n].length = len;
            return n;
        }
        case 't': case 'f': case 'n': {
            static const char *const lit[3] = {"true", "false", "null"};
            int i;
            for (i = 0; i < 3; i++) {
                size_t l = strlen(lit[i]);
                if (WITNESS__CAST(size_t, ps->end - ps->p) >= l && memcmp(ps->p, lit[i], l) == 0) {
                    ps->p += l;
                    n = witness__new_node(ps, i == 2 ? WITNESS_NULL : WITNESS_BOOL);
                    if (n >= 0) ps->nodes[n].number = i == 0 ? 1 : 0;
                    return n;
                }
            }
            ps->failed = 1;
            return -1;
        }
        default: {
            char *s = ps->p;
            int ok;
            double v;
            if (*ps->p == '-') ps->p++;
            while (ps->p < ps->end && ((*ps->p >= '0' && *ps->p <= '9') || *ps->p == '.' || *ps->p == 'e' ||
                                       *ps->p == 'E' || *ps->p == '+' || *ps->p == '-')) ps->p++;
            v = witness__strtod(s, WITNESS__CAST(size_t, ps->p - s), &ok);
            if (!ok) { ps->failed = 1; return -1; }
            n = witness__new_node(ps, WITNESS_NUMBER);
            if (n >= 0) ps->nodes[n].number = v;
            return n;
        }
    }
}

const witness_value *witness_get(const witness_value *o, const char *key) {
    const witness_value *c;
    if (!o || o->type != WITNESS_OBJECT || !key) return NULL;
    for (c = o->child; c; c = c->next) if (c->key && strcmp(c->key, key) == 0) return c;
    return NULL;
}

const witness_value *witness_at(const witness_value *a, size_t i) {
    const witness_value *c;
    if (!a || (a->type != WITNESS_ARRAY && a->type != WITNESS_OBJECT)) return NULL;
    for (c = a->child; c && i; c = c->next) i--;
    return c;
}

double witness_number(const witness_value *v, double def) {
    if (!v) return def;
    if (v->type == WITNESS_NUMBER || v->type == WITNESS_BOOL) return v->number;
    if (v->type == WITNESS_STRING) {
        int ok;
        size_t a = 0, b = v->length;
        double d;
        while (a < b && v->string[a] == ' ') a++;
        while (b > a && v->string[b - 1] == ' ') b--;
        d = witness__strtod(v->string + a, b - a, &ok);
        return ok ? d : def;
    }
    return def;
}

long long witness_int(const witness_value *v, long long def) {
    double d = witness_number(v, WITNESS__CAST(double, def));
    if (d != d || d > 9.2e18 || d < -9.2e18) return def;
    return WITNESS__CAST(long long, d);
}

const char *witness_string(const witness_value *v, const char *def) {
    return v && v->type == WITNESS_STRING ? v->string : def;
}

int witness_bool(const witness_value *v, int def) {
    if (!v) return def;
    if (v->type == WITNESS_BOOL || v->type == WITNESS_NUMBER) return v->number != 0;
    return def;
}

/* ---------------------------------------------------------------- key names */

const char *witness_key_normalize(const char *name, char *out, size_t size) {
    static const char *const alias[][2] = {
        {"return", "enter"}, {"kpenter", "enter"}, {"numpadenter", "enter"}, {"esc", "escape"},
        {"spacebar", "space"}, {" ", "space"}, {"arrowleft", "left"}, {"arrowright", "right"},
        {"arrowup", "up"}, {"arrowdown", "down"}, {"leftarrow", "left"}, {"rightarrow", "right"},
        {"uparrow", "up"}, {"downarrow", "down"}, {"lshift", "shift"}, {"rshift", "shift"},
        {"leftshift", "shift"}, {"rightshift", "shift"}, {"shiftleft", "shift"}, {"shiftright", "shift"},
        {"control", "ctrl"}, {"lctrl", "ctrl"}, {"rctrl", "ctrl"}, {"leftctrl", "ctrl"}, {"rightctrl", "ctrl"},
        {"leftcontrol", "ctrl"}, {"rightcontrol", "ctrl"}, {"controlleft", "ctrl"}, {"controlright", "ctrl"},
        {"lalt", "alt"}, {"ralt", "alt"}, {"leftalt", "alt"}, {"rightalt", "alt"}, {"altleft", "alt"},
        {"altright", "alt"}, {"option", "alt"}, {"altgr", "alt"}, {"del", "delete"}, {"ins", "insert"},
        {"keypadenter", "enter"}, {"pgup", "pageup"}, {"pgdn", "pagedown"}, {"back", "backspace"},
        /* the OS key is "meta" (as in the JS and Godot adapters); "super"/"gui"/"command"/"windows" spellings map to it */
        {"super", "meta"}, {"leftsuper", "meta"}, {"rightsuper", "meta"}, {"lsuper", "meta"}, {"rsuper", "meta"},
        {"superleft", "meta"}, {"superright", "meta"}, {"metaleft", "meta"}, {"metaright", "meta"},
        {"leftmeta", "meta"}, {"rightmeta", "meta"}, {"lmeta", "meta"}, {"rmeta", "meta"}, {"gui", "meta"},
        {"leftgui", "meta"}, {"rightgui", "meta"}, {"lgui", "meta"}, {"rgui", "meta"}, {"cmd", "meta"},
        {"command", "meta"}, {"leftcommand", "meta"}, {"rightcommand", "meta"}, {"windows", "meta"},
        {"leftwindows", "meta"}, {"rightwindows", "meta"}, {"lwin", "meta"}, {"rwin", "meta"}};
    char tmp[64];
    size_t i, n = 0;
    if (!out || !size) return out;
    out[0] = 0;
    if (!name) return out;
    if (name[0] == ' ' && name[1] == 0) { witness__copy(out, size, "space"); return out; }
    /* lowercase, drop spaces/underscores/dashes: "Left Shift" -> "leftshift" */
    for (i = 0; name[i] && n + 1 < sizeof tmp; i++) {
        char c = name[i];
        if (c == ' ' || c == '_' || c == '-') continue;
        if (c >= 'A' && c <= 'Z') c = WITNESS__CAST(char, c - 'A' + 'a');
        tmp[n++] = c;
    }
    tmp[n] = 0;
    if (n == 4 && memcmp(tmp, "key", 3) == 0) memmove(tmp, tmp + 3, 2);        /* KeyA -> a */
    else if (n == 6 && memcmp(tmp, "digit", 5) == 0) memmove(tmp, tmp + 5, 2); /* Digit1 -> 1 */
    for (i = 0; i < sizeof alias / sizeof alias[0]; i++) {
        if (strcmp(tmp, alias[i][0]) == 0) { witness__copy(out, size, alias[i][1]); return out; }
    }
    witness__copy(out, size, tmp);
    return out;
}

/* ---------------------------------------------------------------- global state */

typedef struct witness__log {
    long long frame;
    witness_level level;
    char *message;
} witness__log;

typedef struct witness__state {
    int connected, quit;
    int sock_open, wsa_started;
    witness__socket sock;
    witness_handlers h;
    int fps, audio_rate, audio_channels;
    long long frame, seed;
    double time;
    int seed_chosen;
    /* network in / out */
    char *in;
    size_t in_len, in_cap;
    witness_json out;
    /* command parsing */
    witness__parser parser;
    witness_value *values;
    size_t values_cap;
    char error[512];
    int has_error;
    /* input */
    witness_event *queue;
    size_t queue_len, queue_cap;
    witness_event *cur;
    size_t cur_len, cur_cap;
    char keys[WITNESS__MAX_KEYS][32];
    int key_count;
    double mouse_x, mouse_y;
    int mouse_buttons;
    int touch_native;                        /* hello.touch: no mouse fallback for finger 0 */
    int undrawn;                             /* this frame runs undrawn (step "draw": "last", not its last frame) */
    int touch_down[WITNESS__MAX_TOUCHES];
    double touch_x[WITNESS__MAX_TOUCHES], touch_y[WITNESS__MAX_TOUCHES];
    /* logs + audio (shared with other threads, guarded by the lock) */
    witness__log *logs;
    size_t log_len, log_cap, logs_dropped;
    float *audio;
    size_t audio_cap, audio_head, audio_len; /* ring, in samples */
    long long audio_emitted;                 /* sample frames written since reset */
    /* scratch */
    unsigned char *pixels;
    size_t pixels_cap;
    /* recording */
    FILE *rec;
    long long rec_frame;
    witness_event *rec_events;
    size_t rec_len, rec_cap;
    char rec_mark[64];
    witness_json rec_line;
    witness_json sound_line;                 /* unsolicited "sound" events (sim thread) */
} witness__state;

static witness__state witness__g;

#if defined(WITNESS_WEB_BRIDGE) && !defined(__EMSCRIPTEN_PTHREADS__)
static void witness__lock(void) {}   /* a web build without threads: everything runs on the browser's main thread */
static void witness__unlock(void) {}
#elif defined(WITNESS_WEB_BRIDGE)
#include <pthread.h>
static pthread_mutex_t witness__lock_obj = PTHREAD_MUTEX_INITIALIZER;
static void witness__lock(void) { pthread_mutex_lock(&witness__lock_obj); }
static void witness__unlock(void) { pthread_mutex_unlock(&witness__lock_obj); }
#elif defined(_WIN32)
static SRWLOCK witness__lock_obj = SRWLOCK_INIT;
static void witness__lock(void) { AcquireSRWLockExclusive(&witness__lock_obj); }
static void witness__unlock(void) { ReleaseSRWLockExclusive(&witness__lock_obj); }
#else
static pthread_mutex_t witness__lock_obj = PTHREAD_MUTEX_INITIALIZER;
static void witness__lock(void) { pthread_mutex_lock(&witness__lock_obj); }
static void witness__unlock(void) { pthread_mutex_unlock(&witness__lock_obj); }
#endif

void witness_error(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(witness__g.error, sizeof witness__g.error, fmt, ap);
    va_end(ap);
    witness__g.has_error = 1;
}

int witness_connected(void) { return witness__g.connected; }
long long witness_frame(void) { return witness__g.frame; }
int witness_drawing(void) { return !witness__g.undrawn; }
double witness_time(void) { return witness__g.time; }

long long witness_seed(void) {
    if (!witness__g.seed_chosen) {
        char buf[32];
        int ok = 0;
        double v = 0;
        if (witness__getenv("WITNESS_SEED", buf, sizeof buf)) v = witness__strtod(buf, strlen(buf), &ok);
        witness__g.seed = ok ? WITNESS__CAST(long long, v) : WITNESS__CAST(long long, time(NULL) % 1000000);
        witness__g.seed_chosen = 1;
    }
    return witness__g.seed;
}

#ifdef WITNESS_WEB_BRIDGE
/* The browser side (witness_emscripten.js). EM_JS bodies are stringified onto one line: no // comments in them.
   Quoted ['names'] throughout: emcc --closure 1 renames dotted names, and these cross into the shim. */
EM_JS(int, witness__js_active, (void), {
    var W = globalThis["WitnessEmscripten"];
    return W && W["active"]() ? 1 : 0;
});
EM_JS(int, witness__js_open, (void), {
    var W = globalThis["WitnessEmscripten"];
    if (!W) return 0;
    return W["open"]({
        "heap": function () { return HEAPU8; },
        "inbuf": function (n) { return _witness_emscripten_inbuf(n); },
        "recv": function (n) { return _witness_emscripten_recv(n); },
        "closed": function () { _witness_emscripten_closed(); }
    });
});
EM_JS(void, witness__js_send, (const char *data, int len), {
    var W = globalThis["WitnessEmscripten"];
    if (W) W["send"](HEAPU8, data, len);
});
EM_JS(void, witness__js_close, (void), {
    var W = globalThis["WitnessEmscripten"];
    if (W) W["close"]();
});
EM_JS(void, witness__js_gesture, (int on), {
    var W = globalThis["WitnessEmscripten"];
    if (W) W["gesture"](on);
});
#endif

int witness_active(int argc, char **argv) {
#ifdef WITNESS_WEB_BRIDGE
    (void)argc; (void)argv;
    return witness__js_active();
#else
    char buf[128];
    int i;
    if (witness__getenv("WITNESS_ADDR", buf, sizeof buf)) return 1;
    if (argv) for (i = 1; i < argc; i++) if (argv[i] && strcmp(argv[i], "--witness") == 0) return 1;
    return 0;
#endif
}

/* ---------------------------------------------------------------- logs & audio */

void witness_log(witness_level level, const char *fmt, ...) {
    va_list ap, ap2;
    int n;
    char *msg;
    witness__log *l;
    if (!witness__g.connected) return;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) { va_end(ap2); return; }
    msg = WITNESS__CAST(char *, malloc(WITNESS__CAST(size_t, n) + 1));
    if (!msg) { va_end(ap2); return; }
    vsnprintf(msg, WITNESS__CAST(size_t, n) + 1, fmt, ap2);
    va_end(ap2);
    witness__lock();
    if (witness__g.log_len >= WITNESS__MAX_LOGS) {
        witness__g.logs_dropped++;
        free(msg);
    } else {
        l = WITNESS__CAST(witness__log *, witness__grow(witness__g.logs, &witness__g.log_cap, witness__g.log_len + 1, sizeof(witness__log)));
        if (l) {
            witness__g.logs = l;
            l[witness__g.log_len].frame = witness__g.frame;
            l[witness__g.log_len].level = level;
            l[witness__g.log_len].message = msg;
            witness__g.log_len++;
        } else free(msg);
    }
    witness__unlock();
}

/* Push samples into the ring (lock held). Grows up to the cap, then drops the oldest. */
static void witness__audio_push(const float *src, const short *src16, size_t samples) {
    size_t max = WITNESS__CAST(size_t, witness__g.audio_rate) * WITNESS__CAST(size_t, witness__g.audio_channels) * WITNESS__AUDIO_MAX_SECONDS;
    size_t i;
    if (witness__g.audio_len + samples > witness__g.audio_cap && witness__g.audio_cap < max) {
        size_t want = witness__g.audio_cap ? witness__g.audio_cap : 4096, k;
        float *nb;
        while (want < witness__g.audio_len + samples && want < max) want *= 2;
        if (want > max) want = max;
        nb = WITNESS__CAST(float *, malloc(want * sizeof(float)));
        if (nb) {
            for (k = 0; k < witness__g.audio_len; k++) nb[k] = witness__g.audio[(witness__g.audio_head + k) % witness__g.audio_cap];
            free(witness__g.audio);
            witness__g.audio = nb;
            witness__g.audio_cap = want;
            witness__g.audio_head = 0;
        }
    }
    if (!witness__g.audio_cap) return;
    for (i = 0; i < samples; i++) {
        float s = src ? src[i] : WITNESS__CAST(float, src16[i]) / 32768.0f;
        if (witness__g.audio_len == witness__g.audio_cap) { /* full: drop the oldest sample */
            witness__g.audio_head = (witness__g.audio_head + 1) % witness__g.audio_cap;
            witness__g.audio_len--;
        }
        witness__g.audio[(witness__g.audio_head + witness__g.audio_len) % witness__g.audio_cap] = s;
        witness__g.audio_len++;
    }
}

void witness_audio_write(const float *interleaved, int frames) {
    if (!witness__g.connected || !witness__g.audio_rate || frames <= 0 || !interleaved) return;
    witness__lock();
    witness__audio_push(interleaved, NULL, WITNESS__CAST(size_t, frames) * WITNESS__CAST(size_t, witness__g.audio_channels));
    witness__g.audio_emitted += frames;
    witness__unlock();
}

void witness_audio_write_s16(const short *interleaved, int frames) {
    if (!witness__g.connected || !witness__g.audio_rate || frames <= 0 || !interleaved) return;
    witness__lock();
    witness__audio_push(NULL, interleaved, WITNESS__CAST(size_t, frames) * WITNESS__CAST(size_t, witness__g.audio_channels));
    witness__g.audio_emitted += frames;
    witness__unlock();
}

int witness_audio_frames_for_step(double dt) {
    long long target, n;
    if (!witness__g.connected || !witness__g.audio_rate) return 0;
    target = llround((witness__g.time + dt) * witness__g.audio_rate);
    witness__lock();
    n = target - witness__g.audio_emitted;
    witness__unlock();
    return n > 0 ? WITNESS__CAST(int, n) : 0;
}

/* ---------------------------------------------------------------- input state */

const witness_event *witness_frame_events(int *count) {
    if (count) *count = WITNESS__CAST(int, witness__g.cur_len);
    return witness__g.cur;
}

int witness_key_down(const char *name) {
    char k[32];
    int i;
    witness_key_normalize(name, k, sizeof k);
    for (i = 0; i < witness__g.key_count; i++) if (strcmp(witness__g.keys[i], k) == 0) return 1;
    return 0;
}

void witness_mouse(double *x, double *y, int *buttons) {
    if (x) *x = witness__g.mouse_x;
    if (y) *y = witness__g.mouse_y;
    if (buttons) *buttons = witness__g.mouse_buttons;
}

int witness_touch(int id, double *x, double *y) {
    if (id < 0 || id >= WITNESS__MAX_TOUCHES || !witness__g.touch_down[id]) return 0;
    if (x) *x = witness__g.touch_x[id];
    if (y) *y = witness__g.touch_y[id];
    return 1;
}

static void witness__track(const witness_event *e) {
    int i;
    if (e->type == WITNESS_EV_KEY && e->down >= 0) {
        for (i = 0; i < witness__g.key_count; i++) if (strcmp(witness__g.keys[i], e->name) == 0) break;
        if (e->down && i == witness__g.key_count && i < WITNESS__MAX_KEYS) {
            witness__copy(witness__g.keys[i], sizeof witness__g.keys[i], e->name);
            witness__g.key_count++;
        } else if (!e->down && i < witness__g.key_count) {
            witness__g.key_count--;
            if (i != witness__g.key_count) memcpy(witness__g.keys[i], witness__g.keys[witness__g.key_count], sizeof witness__g.keys[i]);
        }
    } else if (e->type == WITNESS_EV_MOUSE) {
        if (e->has_pos) { witness__g.mouse_x = e->x; witness__g.mouse_y = e->y; }
        if (e->down >= 0 && e->button >= 0 && e->button < 8) {
            if (e->down) witness__g.mouse_buttons |= 1 << e->button;
            else witness__g.mouse_buttons &= ~(1 << e->button);
        }
    } else if (e->type == WITNESS_EV_TOUCH && e->id >= 0 && e->id < WITNESS__MAX_TOUCHES) {
        witness__g.touch_down[e->id] = e->phase != WITNESS_TOUCH_UP && e->phase != WITNESS_TOUCH_CANCEL;
        witness__g.touch_x[e->id] = e->x;
        witness__g.touch_y[e->id] = e->y;
    }
}

static void witness__parse_event(const witness_value *v, witness_event *e) {
    const char *type = witness_string(witness_get(v, "type"), "");
    const witness_value *down = witness_get(v, "down");
    memset(e, 0, sizeof *e);
    e->frame = witness_int(witness_get(v, "frame"), 0);
    e->down = down ? witness_bool(down, 0) : -1;
    e->button = -1;
    if (strcmp(type, "key") == 0) {
        e->type = WITNESS_EV_KEY;
        witness_key_normalize(witness_string(witness_get(v, "key"), ""), e->name, sizeof e->name);
    } else if (strcmp(type, "mouse") == 0) {
        e->type = WITNESS_EV_MOUSE;
        e->has_pos = witness_get(v, "x") != NULL;
        e->x = witness_number(witness_get(v, "x"), 0);
        e->y = witness_number(witness_get(v, "y"), 0);
        e->button = WITNESS__CAST(int, witness_int(witness_get(v, "button"), e->down >= 0 ? 0 : -1));
    } else if (strcmp(type, "wheel") == 0) {
        e->type = WITNESS_EV_WHEEL;
        e->dx = witness_number(witness_get(v, "dx"), 0);
        e->dy = witness_number(witness_get(v, "dy"), 0);
    } else if (strcmp(type, "text") == 0) {
        e->type = WITNESS_EV_TEXT;
        witness__copy(e->text, sizeof e->text, witness_string(witness_get(v, "text"), ""));
    } else if (strcmp(type, "action") == 0) {
        e->type = WITNESS_EV_ACTION;
        witness__copy(e->name, sizeof e->name, witness_string(witness_get(v, "action"), ""));
    } else if (strcmp(type, "pad") == 0) {
        e->type = WITNESS_EV_PAD;
        witness__copy(e->name, sizeof e->name, witness_string(witness_get(v, "button"), ""));
    } else if (strcmp(type, "axis") == 0) {
        e->type = WITNESS_EV_AXIS;
        witness__copy(e->name, sizeof e->name, witness_string(witness_get(v, "axis"), ""));
        e->value = witness_number(witness_get(v, "value"), 0);
    } else if (strcmp(type, "touch") == 0) {
        const char *phase = witness_string(witness_get(v, "phase"), "move");
        e->type = WITNESS_EV_TOUCH;
        e->id = WITNESS__CAST(int, witness_int(witness_get(v, "id"), 0));
        e->has_pos = 1;
        e->x = witness_number(witness_get(v, "x"), 0);
        e->y = witness_number(witness_get(v, "y"), 0);
        e->phase = strcmp(phase, "down") == 0 ? WITNESS_TOUCH_DOWN : strcmp(phase, "up") == 0 ? WITNESS_TOUCH_UP
                 : strcmp(phase, "cancel") == 0 ? WITNESS_TOUCH_CANCEL : WITNESS_TOUCH_MOVE;
        e->down = e->phase == WITNESS_TOUCH_DOWN ? 1 : e->phase == WITNESS_TOUCH_MOVE ? -1 : 0;
        e->pressure = witness_number(witness_get(v, "pressure"), 1);
    } else {
        e->type = WITNESS_EV_OTHER;
        witness__copy(e->name, sizeof e->name, type);
    }
}

/* Protocol shape of an event (shared by recording). */
static void witness__write_event(witness_json *w, const witness_event *e) {
    static const char *const names[] = {"key", "mouse", "wheel", "text", "action", "pad", "axis"};
    static const char *const phases[] = {"down", "move", "up", "cancel"};
    witness_json_begin_object(w);
    witness_json_field_string(w, "type", e->type == WITNESS_EV_TOUCH ? "touch" : e->type >= WITNESS_EV_OTHER ? e->name : names[e->type]);
    switch (e->type) {
        case WITNESS_EV_KEY: witness_json_field_string(w, "key", e->name); break;
        case WITNESS_EV_MOUSE:
            if (e->has_pos) { witness_json_field_number(w, "x", e->x); witness_json_field_number(w, "y", e->y); }
            if (e->down >= 0) witness_json_field_int(w, "button", e->button < 0 ? 0 : e->button);
            break;
        case WITNESS_EV_WHEEL:
            if (e->dx != 0) witness_json_field_number(w, "dx", e->dx);
            witness_json_field_number(w, "dy", e->dy);
            break;
        case WITNESS_EV_TEXT: witness_json_field_string(w, "text", e->text); break;
        case WITNESS_EV_ACTION: witness_json_field_string(w, "action", e->name); break;
        case WITNESS_EV_PAD: witness_json_field_string(w, "button", e->name); break;
        case WITNESS_EV_AXIS:
            witness_json_field_string(w, "axis", e->name);
            witness_json_field_number(w, "value", e->value);
            break;
        case WITNESS_EV_TOUCH:
            witness_json_field_int(w, "id", e->id);
            witness_json_field_number(w, "x", e->x);
            witness_json_field_number(w, "y", e->y);
            witness_json_field_string(w, "phase", phases[e->phase >= WITNESS_TOUCH_DOWN && e->phase <= WITNESS_TOUCH_CANCEL ? e->phase : WITNESS_TOUCH_MOVE]);
            if (e->pressure > 0 && e->pressure != 1) witness_json_field_number(w, "pressure", e->pressure);
            break;
        default: break;
    }
    if (e->down >= 0 && e->type != WITNESS_EV_TOUCH) witness_json_field_bool(w, "down", e->down);
    witness_json_end_object(w);
}

/* ---------------------------------------------------------------- socket */

#ifdef WITNESS_WEB_BRIDGE
/* web builds: the shim's WebSocket instead of a socket (it queues lines until the socket is open) */
static int witness__send_all(const char *data, size_t n) {
    if (!witness__g.sock_open) return 0;
    witness__js_send(data, WITNESS__CAST(int, n));
    return 1;
}

static void witness__disconnect(void) {
    if (witness__g.sock_open) witness__js_close();
    witness__g.sock_open = 0;
    witness__g.connected = 0;
}
#else
static int witness__send_all(const char *data, size_t n) {
    while (n > 0) {
        int chunk = n > 0x40000000u ? 0x40000000 : WITNESS__CAST(int, n);
#ifdef _WIN32
        int sent = send(witness__g.sock, data, chunk, 0);
        if (sent == SOCKET_ERROR) return 0;
#else
        ssize_t sent = send(witness__g.sock, data, WITNESS__CAST(size_t, chunk), MSG_NOSIGNAL);
        if (sent < 0) { if (errno == EINTR) continue; return 0; }
#endif
        data += sent;
        n -= WITNESS__CAST(size_t, sent);
    }
    return 1;
}

static void witness__disconnect(void) {
    if (witness__g.sock_open) witness__closesocket(witness__g.sock);
    witness__g.sock_open = 0;
    witness__g.connected = 0;
}

/* Wait until the socket is readable: 1 readable, 0 timeout, -1 error (EINTR retried). */
static int witness__wait_readable(double timeout_ms) {
#ifdef _WIN32
    fd_set rd;
    struct timeval tv;
    int r;
    FD_ZERO(&rd);
    FD_SET(witness__g.sock, &rd);
    if (timeout_ms >= 0) {
        tv.tv_sec = WITNESS__CAST(long, timeout_ms / 1000);
        tv.tv_usec = WITNESS__CAST(long, fmod(timeout_ms, 1000.0) * 1000);
    }
    r = select(0, &rd, NULL, NULL, timeout_ms >= 0 ? &tv : NULL);
    return r < 0 ? -1 : r > 0;
#else
    struct pollfd pfd;
    int r;
    pfd.fd = witness__g.sock;
    pfd.events = POLLIN;
    pfd.revents = 0;
    do r = poll(&pfd, 1, timeout_ms >= 0 ? WITNESS__CAST(int, timeout_ms) : -1);
    while (r < 0 && errno == EINTR);
    return r < 0 ? -1 : r > 0;
#endif
}
#endif /* WITNESS_WEB_BRIDGE */

static int witness__send_out(void) {
    witness_json *w = &witness__g.out;
    if (w->failed) return 0;
    witness__jw_putc(w, '\n');
    if (w->failed || !witness__send_all(w->buf, w->len)) { witness__disconnect(); return 0; }
    return 1;
}

#ifndef WITNESS_WEB_BRIDGE
static witness__socket witness__dial(const char *host, const char *port) {
    struct addrinfo hints, *res = NULL, *ai;
    witness__socket s = WITNESS__NO_SOCKET;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    if (getaddrinfo(host, port, &hints, &res) != 0) return WITNESS__NO_SOCKET;
    for (ai = res; ai; ai = ai->ai_next) {
        s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == WITNESS__NO_SOCKET) continue;
#ifdef _WIN32
        if (connect(s, ai->ai_addr, WITNESS__CAST(int, ai->ai_addrlen)) == 0) break;
#else
        if (connect(s, ai->ai_addr, ai->ai_addrlen) == 0) break;
#endif
        witness__closesocket(s);
        s = WITNESS__NO_SOCKET;
    }
    freeaddrinfo(res);
    if (s != WITNESS__NO_SOCKET) {
        int one = 1;
        setsockopt(s, IPPROTO_TCP, TCP_NODELAY, WITNESS__CAST(const char *, WITNESS__CAST(const void *, &one)), sizeof one);
#ifdef SO_NOSIGPIPE
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    }
    return s;
}
#endif

/* ---------------------------------------------------------------- sound events */

void witness_sound(const char *name) { witness_sound_ex(name, -1, 0, 0, 0); }

/* Own buffer, so a sound started inside a handler never touches the reply being built.
 * A failed send is left for the next reply to detect (it disconnects then). */
void witness_sound_ex(const char *name, double volume, int has_pos, double x, double y) {
    witness_json *w = &witness__g.sound_line;
    if (!witness__g.connected || !name || !*name) return;
    witness__jw_clear(w);
    witness_json_begin_object(w);
    witness_json_field_string(w, "event", "sound");
    witness_json_field_string(w, "name", name);
    witness_json_field_int(w, "frame", witness__g.frame);
    if (volume >= 0) witness_json_field_number(w, "volume", volume < 1 ? volume : 1.0);
    if (has_pos) {
        witness_json_key(w, "pos");
        witness_json_vec2(w, x, y);
    }
    witness_json_end_object(w);
    witness__jw_putc(w, '\n');
    if (!w->failed) witness__send_all(w->buf, w->len);
}

/* ---------------------------------------------------------------- commands */

static void witness__reply_begin(double id) {
    witness_json *w = &witness__g.out;
    witness__jw_clear(w);
    witness_json_begin_object(w);
    witness_json_field_number(w, "id", id);
    witness_json_field_bool(w, "ok", 1);
}

static void witness__reply_fail(double id, const char *msg) {
    witness_json *w = &witness__g.out;
    witness__jw_clear(w);
    witness_json_begin_object(w);
    witness_json_field_number(w, "id", id);
    witness_json_field_bool(w, "ok", 0);
    witness_json_field_string(w, "error", msg);
    witness_json_end_object(w);
}

/* After a handler: report its failure, or close what it left open. */
static int witness__handler_ok(int returned, double id, const char *what) {
    if (!returned || witness__g.has_error) {
        char msg[600];
        if (witness__g.has_error) witness__copy(msg, sizeof msg, witness__g.error);
        else snprintf(msg, sizeof msg, "%s failed", what);
        witness__reply_fail(id, msg);
        return 0;
    }
    witness__jw_close_to(&witness__g.out, 1);
    return 1;
}

static void witness__reset_sim(long long seed) {
    witness__g.frame = 0;
    witness__g.time = 0;
    witness__g.seed = seed;
    witness__g.seed_chosen = 1;
    witness__g.queue_len = 0;
    witness__g.cur_len = 0;
    witness__g.key_count = 0;
    witness__g.mouse_x = witness__g.mouse_y = 0;
    witness__g.mouse_buttons = 0;
    memset(witness__g.touch_down, 0, sizeof witness__g.touch_down);
    witness__lock();
    witness__g.audio_len = 0;
    witness__g.audio_head = 0;
    witness__g.audio_emitted = 0;
    witness__unlock();
}

static void witness__queue_event(const witness_event *e) {
    witness_event *q = WITNESS__CAST(witness_event *, witness__grow(witness__g.queue, &witness__g.queue_cap, witness__g.queue_len + 1, sizeof(witness_event)));
    if (!q) return;
    witness__g.queue = q;
    q[witness__g.queue_len++] = *e;
}

/* Move the events due at the current frame (frame <= current, queue order) into cur. */
static void witness__take_due(void) {
    size_t i, keep = 0;
    witness__g.cur_len = 0;
    for (i = 0; i < witness__g.queue_len; i++) {
        witness_event *e = &witness__g.queue[i];
        if (e->frame <= witness__g.frame) {
            witness_event *c = WITNESS__CAST(witness_event *, witness__grow(witness__g.cur, &witness__g.cur_cap, witness__g.cur_len + 1, sizeof(witness_event)));
            if (!c) continue;
            witness__g.cur = c;
            c[witness__g.cur_len++] = *e;
        } else {
            witness__g.queue[keep++] = *e;
        }
    }
    witness__g.queue_len = keep;
}

static int witness__screenshot(double id, double scale) {
    witness_image img;
    witness_json *w = &witness__g.out;
    const unsigned char *src;
    size_t stride, ow, oh, x, y, bytes;
    int ok;
    memset(&img, 0, sizeof img);
    witness__g.has_error = 0;
    ok = witness__g.h.screenshot(witness__g.h.user, &img);
    if (ok && (!img.rgba || img.width <= 0 || img.height <= 0)) { witness_error("screenshot handler returned no pixels"); ok = 0; }
    if (!ok || witness__g.has_error) {
        witness__reply_fail(id, witness__g.has_error ? witness__g.error : "screenshot failed");
        return 0;
    }
    stride = img.stride > 0 ? WITNESS__CAST(size_t, img.stride) : WITNESS__CAST(size_t, img.width) * 4;
    if (!(scale > 0) || scale > 16) scale = 1;
    ow = WITNESS__CAST(size_t, floor(img.width * scale + 0.5));
    oh = WITNESS__CAST(size_t, floor(img.height * scale + 0.5));
    if (ow < 1) ow = 1;
    if (oh < 1) oh = 1;
    bytes = ow * oh * 4;
    if (ow == WITNESS__CAST(size_t, img.width) && oh == WITNESS__CAST(size_t, img.height) && !img.bottom_up && stride == ow * 4) {
        src = img.rgba; /* already tight, top-down, unscaled: encode directly */
    } else {
        unsigned char *dst = WITNESS__CAST(unsigned char *, witness__grow(witness__g.pixels, &witness__g.pixels_cap, bytes, 1));
        if (!dst) { witness__reply_fail(id, "out of memory"); return 0; }
        witness__g.pixels = dst;
        for (y = 0; y < oh; y++) {
            size_t sy = WITNESS__CAST(size_t, (double)y * img.height / (double)oh);
            if (img.bottom_up) sy = WITNESS__CAST(size_t, img.height) - 1 - sy;
            for (x = 0; x < ow; x++) {
                size_t sx = WITNESS__CAST(size_t, (double)x * img.width / (double)ow);
                memcpy(dst + (y * ow + x) * 4, img.rgba + sy * stride + sx * 4, 4);
            }
        }
        src = dst;
    }
    witness__reply_begin(id);
    witness_json_field_int(w, "width", WITNESS__CAST(long long, ow));
    witness_json_field_int(w, "height", WITNESS__CAST(long long, oh));
    witness_json_field_string(w, "format", "rgba8");
    witness_json_key(w, "data");
    witness_json_base64(w, src, bytes);
    witness_json_end_object(w);
    return 1;
}

static void witness__audio_reply(double id) {
    witness_json *w = &witness__g.out;
    size_t n, i, bytes;
    unsigned char *tmp;
    const unsigned one = 1;
    int big_endian = *WITNESS__CAST(const unsigned char *, WITNESS__CAST(const void *, &one)) == 0;
    witness__lock();
    n = witness__g.audio_len;
    bytes = n * 4;
    tmp = WITNESS__CAST(unsigned char *, witness__grow(witness__g.pixels, &witness__g.pixels_cap, bytes ? bytes : 1, 1));
    if (tmp) {
        witness__g.pixels = tmp;
        for (i = 0; i < n; i++) {
            float s = witness__g.audio[(witness__g.audio_head + i) % witness__g.audio_cap];
            unsigned char *b = tmp + i * 4;
            memcpy(b, &s, 4);
            if (big_endian) { unsigned char t = b[0]; b[0] = b[3]; b[3] = t; t = b[1]; b[1] = b[2]; b[2] = t; }
        }
        witness__g.audio_len = 0;
        witness__g.audio_head = 0;
    }
    witness__unlock();
    if (!tmp) { witness__reply_fail(id, "out of memory"); return; }
    witness__reply_begin(id);
    witness_json_field_int(w, "sampleRate", witness__g.audio_rate);
    witness_json_field_int(w, "channels", witness__g.audio_channels);
    witness_json_field_string(w, "format", "f32");
    witness_json_key(w, "data");
    witness_json_base64(w, tmp, bytes);
    witness_json_end_object(w);
}

static void witness__logs_reply(double id) {
    static const char *const levels[] = {"info", "warn", "error"};
    witness_json *w = &witness__g.out;
    size_t i;
    witness__reply_begin(id);
    witness_json_key(w, "logs");
    witness_json_begin_array(w);
    witness__lock();
    for (i = 0; i < witness__g.log_len; i++) {
        witness__log *l = &witness__g.logs[i];
        witness_json_begin_object(w);
        witness_json_field_int(w, "frame", l->frame);
        witness_json_field_string(w, "level", levels[l->level <= WITNESS_ERROR ? l->level : WITNESS_INFO]);
        witness_json_field_string(w, "message", l->message);
        witness_json_end_object(w);
        free(l->message);
    }
    witness__g.log_len = 0;
    if (witness__g.logs_dropped) {
        char msg[96];
        snprintf(msg, sizeof msg, "witness: %lu log lines dropped (buffer full)", WITNESS__CAST(unsigned long, witness__g.logs_dropped));
        witness_json_begin_object(w);
        witness_json_field_int(w, "frame", witness__g.frame);
        witness_json_field_string(w, "level", "warn");
        witness_json_field_string(w, "message", msg);
        witness_json_end_object(w);
        witness__g.logs_dropped = 0;
    }
    witness__unlock();
    witness_json_end_array(w);
    witness_json_end_object(w);
}

static void witness__dispatch(const witness_value *m) {
    witness__state *g = &witness__g;
    witness_json *w = &g->out;
    double id = witness_number(witness_get(m, "id"), 0);
    const char *cmd = witness_string(witness_get(m, "cmd"), "");
    g->has_error = 0;
    g->error[0] = 0;

    if (strcmp(cmd, "step") == 0) {
        long long frames = witness_int(witness_get(m, "frames"), 1), i;
        const witness_value *dts = witness_get(m, "dts");
        const witness_value *dtv = dts && dts->type == WITNESS_ARRAY ? dts->child : NULL;
        double dt = witness_number(witness_get(m, "dt"), 1.0 / g->fps);
        int lazy = strcmp(witness_string(witness_get(m, "draw"), ""), "last") == 0;
        if (frames < 1) { witness__reply_fail(id, "step: 'frames' must be >= 1"); return; }
        if (!(dt > 0)) dt = 1.0 / g->fps;
        for (i = 0; i < frames && !g->has_error; i++) {
            size_t k;
            double fdt = dtv ? witness_number(dtv, dt) : dt;
            if (dtv) dtv = dtv->next;
            witness__take_due();
            for (k = 0; k < g->cur_len; k++) {
                witness__track(&g->cur[k]);
#ifdef WITNESS_WEB_BRIDGE
                if (g->h.input) {
                    /* input browsers count as a user gesture (key down, mouse button, finger lifted): while the game's
                     * handler runs, the page's audio policy lets it resume an AudioContext, as a real tap would */
                    const witness_event *e = &g->cur[k];
                    int gesture = (e->type == WITNESS_EV_KEY && e->down == 1 && strcmp(e->name, "escape") != 0) ||
                                  (e->type == WITNESS_EV_MOUSE && e->down >= 0) || (e->type == WITNESS_EV_TOUCH && e->phase == WITNESS_TOUCH_UP) ||
                                  e->type == WITNESS_EV_TEXT || (e->type == WITNESS_EV_ACTION && e->down == 1);
                    if (gesture) witness__js_gesture(1);
                    g->h.input(g->h.user, e);
                    if (gesture) witness__js_gesture(0);
                }
#else
                if (g->h.input) g->h.input(g->h.user, &g->cur[k]);
#endif
            }
            g->undrawn = lazy && i < frames - 1;
            g->h.step(g->h.user, fdt);
            g->undrawn = 0;
            g->cur_len = 0;
            g->frame++;
            g->time += fdt;
        }
        witness__reply_begin(id);
        if (!witness__handler_ok(1, id, "step")) return;
        witness_json_field_int(w, "frame", g->frame);
        witness_json_field_number(w, "time", g->time);
        witness_json_end_object(w);
    } else if (strcmp(cmd, "input") == 0) {
        const witness_value *ev = witness_get(m, "events"), *e;
        witness_event parsed;
        for (e = ev && ev->type == WITNESS_ARRAY ? ev->child : NULL; e; e = e->next) {
            witness__parse_event(e, &parsed);
            witness__queue_event(&parsed);
            if (parsed.type == WITNESS_EV_TOUCH && parsed.id == 0 && !g->touch_native) {
                /* mouse fallback: finger 0 is also the mouse (down -> button 0 down, move, up/cancel -> button up) */
                witness_event mouse;
                memset(&mouse, 0, sizeof mouse);
                mouse.type = WITNESS_EV_MOUSE;
                mouse.frame = parsed.frame;
                mouse.has_pos = 1;
                mouse.x = parsed.x;
                mouse.y = parsed.y;
                mouse.down = parsed.down;
                mouse.button = parsed.down >= 0 ? 0 : -1;
                mouse.from_touch = 1;
                witness__queue_event(&mouse);
            }
        }
        witness__reply_begin(id);
        witness_json_end_object(w);
    } else if (strcmp(cmd, "snapshot") == 0) {
        witness__reply_begin(id);
        witness_json_field_int(w, "frame", g->frame);
        witness_json_field_number(w, "time", g->time);
        witness_json_key(w, "state");
        g->h.snapshot(g->h.user, w, witness_get(m, "paths"));
        if (w->after_key) { w->after_key = 0; witness__jw_put(w, "{}", 2); }
        if (!witness__handler_ok(1, id, "snapshot")) return;
        witness_json_end_object(w);
    } else if (strcmp(cmd, "reset") == 0) {
        long long seed = witness_int(witness_get(m, "seed"), 1);
        int ok = 1;
        witness__reset_sim(seed);
        if (g->h.reset) ok = g->h.reset(g->h.user, seed, witness_string(witness_get(m, "scene"), NULL), witness_get(m, "params"));
        witness__reply_begin(id);
        if (!witness__handler_ok(ok, id, "reset")) return;
        witness_json_end_object(w);
    } else if (strcmp(cmd, "screenshot") == 0 && g->h.screenshot) {
        witness__screenshot(id, witness_number(witness_get(m, "scale"), 1));
    } else if (strcmp(cmd, "audio") == 0 && g->audio_rate > 0) {
        witness__audio_reply(id);
    } else if (strcmp(cmd, "call") == 0 && g->h.call) {
        const char *name = witness_string(witness_get(m, "name"), "");
        const witness_value *args = witness_get(m, "args");
        int ok;
        witness__reply_begin(id);
        witness_json_key(w, "result");
        ok = g->h.call(g->h.user, name, args, w);
        if (!ok && !g->has_error) witness_error("unknown call '%s'", name);
        if (!witness__handler_ok(ok, id, "call")) return;
        witness_json_end_object(w);
    } else if (strcmp(cmd, "eval") == 0 && g->h.eval) {
        int ok;
        witness__reply_begin(id);
        witness_json_key(w, "value");
        ok = g->h.eval(g->h.user, witness_string(witness_get(m, "expr"), ""), w);
        if (!witness__handler_ok(ok, id, "eval")) return;
        witness_json_end_object(w);
    } else if (strcmp(cmd, "logs") == 0) {
        witness__logs_reply(id);
    } else if (strcmp(cmd, "perf") == 0 && g->h.perf) {
        witness__reply_begin(id);
        g->h.perf(g->h.user, w);
        if (!witness__handler_ok(1, id, "perf")) return;
        witness_json_end_object(w);
    } else if (strcmp(cmd, "quit") == 0) {
        witness__reply_begin(id);
        witness_json_end_object(w);
        g->quit = 1;
    } else {
        char msg[160];
        snprintf(msg, sizeof msg, "unknown command '%.100s'", cmd);
        witness__reply_fail(id, msg);
    }
}

/* Parse one protocol line (mutated in place) and answer it. */
static void witness__handle_line(char *line, size_t len) {
    witness__parser *ps = &witness__g.parser;
    long root;
    size_t i;
    if (len >= 2 && line[0] == '@' && line[1] == 'w') { line += 2; len -= 2; }
    ps->p = line;
    ps->end = line + len;
    ps->count = 0;
    ps->failed = 0;
    root = witness__parse_value(ps, 0);
    if (root < 0 || ps->failed || ps->nodes[root].type != WITNESS_OBJECT) {
        fprintf(stderr, "[witness] ignoring malformed command line\n");
        return;
    }
    {
        witness_value *v = WITNESS__CAST(witness_value *, witness__grow(witness__g.values, &witness__g.values_cap, ps->count, sizeof(witness_value)));
        if (!v) return;
        witness__g.values = v;
        for (i = 0; i < ps->count; i++) {
            witness__node *n = &ps->nodes[i];
            v[i].type = n->type;
            v[i].number = n->number;
            v[i].string = n->string;
            v[i].length = n->length;
            v[i].key = n->key;
            v[i].child = n->child >= 0 ? &v[n->child] : NULL;
            v[i].next = n->next >= 0 ? &v[n->next] : NULL;
        }
        witness__dispatch(&v[root]);
    }
    witness__send_out();
}

/* Handle every complete line in the input buffer. Returns how many were handled. */
static int witness__drain_lines(void) {
    int handled = 0;
    size_t start = 0, i;
    for (i = 0; i < witness__g.in_len && witness__g.connected && !witness__g.quit; i++) {
        if (witness__g.in[i] != '\n') continue;
        {
            size_t len = i - start;
            char *line = witness__g.in + start;
            if (len && line[len - 1] == '\r') len--;
            line[len] = 0;
            while (len && (*line == ' ' || *line == '\t')) { line++; len--; }
            if (len) { witness__handle_line(line, len); handled++; }
        }
        start = i + 1;
    }
    if (start) {
        memmove(witness__g.in, witness__g.in + start, witness__g.in_len - start);
        witness__g.in_len -= start;
    }
    return handled;
}

#ifdef WITNESS_WEB_BRIDGE
/* web builds: commands arrive through witness_emscripten_recv (the browser can't block), so polling only handles
 * what is already buffered */
EMSCRIPTEN_KEEPALIVE char *witness_emscripten_inbuf(int size) {
    char *p;
    if (size < 0) return NULL;
    p = WITNESS__CAST(char *, witness__grow(witness__g.in, &witness__g.in_cap, witness__g.in_len + WITNESS__CAST(size_t, size) + 1, 1));
    if (!p) return NULL;
    witness__g.in = p;
    return witness__g.in + witness__g.in_len;
}

EMSCRIPTEN_KEEPALIVE int witness_emscripten_recv(int len) {
    if (!witness__g.connected || len <= 0 || witness__g.in_len + WITNESS__CAST(size_t, len) + 1 > witness__g.in_cap) return witness__g.connected;
    witness__g.in_len += WITNESS__CAST(size_t, len);
    witness__drain_lines();
    if (witness__g.quit) witness__disconnect();
    return witness__g.connected;
}

EMSCRIPTEN_KEEPALIVE void witness_emscripten_closed(void) {
    witness__g.sock_open = 0;
    witness__g.connected = 0;
}

int witness_poll(int timeout_ms) {
    (void)timeout_ms;
    if (!witness__g.connected) return 0;
    witness__drain_lines();
    if (witness__g.quit) witness__disconnect();
    return witness__g.connected;
}

/* Hand control back to the browser and keep the runtime alive: the code after witness_run() in main() (usually
 * witness_shutdown()) never runs, exactly like emscripten_set_main_loop(..., 1). */
void witness_run(void) {
    if (witness__g.connected) emscripten_exit_with_live_runtime();
}
#else
int witness_poll(int timeout_ms) {
    double deadline = timeout_ms >= 0 ? witness__now_ms() + timeout_ms : 0;
    if (!witness__g.connected) return 0;
    for (;;) {
        double left = -1;
        int r;
        long got;
        if (witness__drain_lines() > 0 || witness__g.quit || !witness__g.connected) break;
        if (timeout_ms >= 0) {
            left = deadline - witness__now_ms();
            if (left < 0) left = 0;
        }
        r = witness__wait_readable(left);
        if (r < 0) { witness__disconnect(); break; }
        if (r == 0) return 1; /* timed out, still connected */
        {
            char *p = WITNESS__CAST(char *, witness__grow(witness__g.in, &witness__g.in_cap, witness__g.in_len + 65536 + 1, 1));
            if (!p) { witness__disconnect(); break; }
            witness__g.in = p;
        }
        got = WITNESS__CAST(long, recv(witness__g.sock, witness__g.in + witness__g.in_len, 65536, 0));
        if (got <= 0) {
#ifndef _WIN32
            if (got < 0 && errno == EINTR) continue;
#endif
            witness__disconnect();
            break;
        }
        witness__g.in_len += WITNESS__CAST(size_t, got);
    }
    if (witness__g.quit) witness__disconnect();
    return witness__g.connected;
}

void witness_run(void) {
    while (witness_poll(-1)) {}
}
#endif /* WITNESS_WEB_BRIDGE */

/* Witness runs games unattended: a crash, abort() or assert must print to stderr and exit
 * non-zero, never pop a dialog that waits for a human. Called only in witness mode. */
static void witness__quiet_crashes(void) {
#ifdef _WIN32
    SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
#ifdef _MSC_VER
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#ifdef _DEBUG /* debug CRT: assert/error reports go to stderr instead of a message box */
    _CrtSetReportMode(_CRT_WARN, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_WARN, _CRTDBG_FILE_STDERR);
    _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ERROR, _CRTDBG_FILE_STDERR);
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
#endif
#endif
}

int witness_connect(const witness_hello *hello, const witness_handlers *handlers) {
#ifndef WITNESS_WEB_BRIDGE
    char addr[128], host[100], port[16];
    const char *colon;
    double give_up;
#endif
    witness_json *w = &witness__g.out;
    if (witness__g.connected) return 1;
    witness__quiet_crashes();
    if (!handlers || !handlers->step || !handlers->snapshot) {
        fprintf(stderr, "[witness] witness_connect: the step and snapshot handlers are required\n");
        return 0;
    }
#ifdef WITNESS_WEB_BRIDGE
    /* the shim opens the WebSocket; the hello below waits in its queue until the socket is open */
    if (!witness__js_open()) {
        fprintf(stderr, "[witness] no witness_emscripten.js in the page (link it with --pre-js) or no ?witness= address\n");
        return 0;
    }
#else
    if (!witness__getenv("WITNESS_ADDR", addr, sizeof addr)) witness__copy(addr, sizeof addr, "127.0.0.1:7357");
    colon = strrchr(addr, ':');
    if (!colon || colon == addr || WITNESS__CAST(size_t, colon - addr) >= sizeof host) {
        fprintf(stderr, "[witness] bad WITNESS_ADDR '%s' (want host:port)\n", addr);
        return 0;
    }
    memcpy(host, addr, WITNESS__CAST(size_t, colon - addr));
    host[colon - addr] = 0;
    witness__copy(port, sizeof port, colon + 1);
#ifdef _WIN32
    {
        WSADATA wsa;
        if (!witness__g.wsa_started) {
            if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { fprintf(stderr, "[witness] WSAStartup failed\n"); return 0; }
            witness__g.wsa_started = 1;
        }
    }
#endif
    give_up = witness__now_ms() + 10000;
    for (;;) {
        witness__g.sock = witness__dial(host, port);
        if (witness__g.sock != WITNESS__NO_SOCKET) break;
        if (witness__now_ms() > give_up) {
            fprintf(stderr, "[witness] could not connect to %s (is 'witness' listening?)\n", addr);
            return 0;
        }
        witness__sleep_ms(100);
    }
#endif
    witness__g.sock_open = 1;
    witness__g.connected = 1;
    witness__g.quit = 0;
    witness__g.h = *handlers;
    witness__g.fps = hello && hello->fps > 0 ? hello->fps : 60;
    witness__g.audio_rate = hello && hello->audio_sample_rate > 0 ? hello->audio_sample_rate : 0;
    witness__g.audio_channels = hello && hello->audio_channels > 0 ? hello->audio_channels : 1;
    witness__g.touch_native = hello && hello->touch;
    witness__reset_sim(1);

    witness__jw_clear(w);
    witness_json_begin_object(w);
    witness_json_key(w, "hello");
    witness_json_begin_object(w);
    witness_json_field_int(w, "protocol", WITNESS_PROTOCOL);
    witness_json_field_string(w, "name", hello && hello->name ? hello->name : "game");
    witness_json_field_string(w, "engine", hello && hello->engine ? hello->engine : "custom");
    witness_json_field_string(w, "language", hello && hello->language ? hello->language : "c++");
    witness_json_field_string(w, "adapter", "witness.h " WITNESS_VERSION);
    witness_json_field_int(w, "fps", witness__g.fps);
    if (hello && hello->width > 0 && hello->height > 0) {
        witness_json_key(w, "size");
        witness_json_vec2(w, hello->width, hello->height);
    }
    witness_json_key(w, "capabilities");
    witness_json_begin_array(w);
    if (handlers->reset) witness_json_string(w, "reset");
    witness_json_string(w, "step");
    witness_json_string(w, "input");
    witness_json_string(w, "snapshot");
    if (handlers->screenshot) witness_json_string(w, "screenshot");
    if (witness__g.audio_rate) witness_json_string(w, "audio");
    if (handlers->call) witness_json_string(w, "call");
    if (handlers->eval) witness_json_string(w, "eval");
    witness_json_string(w, "logs");
    if (handlers->perf) witness_json_string(w, "perf");
    witness_json_end_array(w);
    if (hello && hello->calls && hello->call_count > 0) {
        int i;
        witness_json_key(w, "calls");
        witness_json_begin_array(w);
        for (i = 0; i < hello->call_count; i++) {
            witness_json_begin_object(w);
            witness_json_field_string(w, "name", hello->calls[i].name);
            if (hello->calls[i].args) witness_json_field_string(w, "args", hello->calls[i].args);
            if (hello->calls[i].help) witness_json_field_string(w, "help", hello->calls[i].help);
            witness_json_end_object(w);
        }
        witness_json_end_array(w);
    }
    if (hello && hello->keys && hello->key_count > 0) {
        int i;
        witness_json_key(w, "keys");
        witness_json_begin_array(w);
        for (i = 0; i < hello->key_count; i++) witness_json_string(w, hello->keys[i]);
        witness_json_end_array(w);
    }
    if (witness__g.touch_native) witness_json_field_bool(w, "touch", 1);
    witness_json_end_object(w);
    witness_json_end_object(w);
    return witness__send_out();
}

/* ---------------------------------------------------------------- recording */

#ifdef _WIN32
static FILE *witness__open_record_file(void) {
    wchar_t path[1024];
    wchar_t *p;
    FILE *f = NULL;
    DWORD n = GetEnvironmentVariableW(L"WITNESS_RECORD", path, 1024);
    if (n == 0 || n >= 1024) return NULL;
    for (p = path; *p; p++) {
        if ((*p == L'\\' || *p == L'/') && p != path && p[-1] != L':') {
            wchar_t c = *p;
            *p = 0;
            CreateDirectoryW(path, NULL);
            *p = c;
        }
    }
    if (_wfopen_s(&f, path, L"wb") != 0) return NULL;
    return f;
}
#else
static FILE *witness__open_record_file(void) {
    const char *env = getenv("WITNESS_RECORD");
    char path[4096];
    char *p;
    if (!env || !*env || strlen(env) >= sizeof path) return NULL;
    witness__copy(path, sizeof path, env);
    for (p = path + 1; *p; p++) {
        if (*p == '/') { *p = 0; mkdir(path, 0777); *p = '/'; }
    }
    return fopen(path, "wb");
}
#endif

/* UTC ISO-8601 without gmtime (portable, thread-safe). */
static void witness__iso_now(char *out, size_t size) {
    long long t = WITNESS__CAST(long long, time(NULL));
    long long days = t / 86400, secs = t % 86400, z, era, doe, yoe, y, doy, mp, d, m;
    if (secs < 0) { secs += 86400; days--; }
    z = days + 719468;
    era = (z >= 0 ? z : z - 146096) / 146097;
    doe = z - era * 146097;
    yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    y = yoe + era * 400;
    doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    mp = (5 * doy + 2) / 153;
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y++;
    snprintf(out, size, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lldZ", y, m, d, secs / 3600, (secs / 60) % 60, secs % 60);
}

static int witness__record_open(const char *game_name, int fps, long long seed, const char *params_json) {
    witness_json *w = &witness__g.rec_line;
    char started[64];
    if (witness__g.connected || witness_active(0, NULL)) return 0;
    witness__g.rec = witness__open_record_file();
    if (!witness__g.rec) return 0;
    witness__g.rec_frame = 0;
    witness__g.rec_len = 0;
    witness__g.rec_mark[0] = 0;
    witness__iso_now(started, sizeof started);
    witness__jw_clear(w);
    witness_json_begin_object(w);
    witness_json_field_int(w, "replay", 1);
    witness_json_field_string(w, "name", game_name ? game_name : "game");
    witness_json_field_int(w, "seed", seed);
    witness_json_field_int(w, "fps", fps > 0 ? fps : 60);
    if (params_json && *params_json) {
        witness_json_key(w, "params");
        witness_json_raw(w, params_json);
    }
    witness_json_field_string(w, "started", started);
    witness_json_field_string(w, "adapter", "witness.h " WITNESS_VERSION);
    witness_json_end_object(w);
    fprintf(witness__g.rec, "%s\n", w->buf);
    fflush(witness__g.rec);
    return 1;
}

int witness_record_start(const char *game_name, int fps) {
    if (witness__g.rec) return 1;
    return witness__record_open(game_name, fps, witness_seed(), NULL);
}

int witness_record_begin(const char *game_name, int fps, long long seed, const char *params_json) {
    witness_record_stop();
    witness__g.seed = seed;
    witness__g.seed_chosen = 1;
    return witness__record_open(game_name, fps, seed, params_json);
}

int witness_recording(void) { return witness__g.rec != NULL; }

void witness_mark(const char *label) {
    if (!witness__g.rec) return;
    witness__copy(witness__g.rec_mark, sizeof witness__g.rec_mark, label && *label ? label : "mark");
}

void witness_record_event(const witness_event *e) {
    witness_event *q;
    if (!witness__g.rec || !e) return;
    if (e->type == WITNESS_EV_KEY && strcmp(e->name, "f8") == 0) { /* F8 marks, it isn't gameplay */
        if (e->down == 1) witness_mark("F8");
        return;
    }
    if (e->type == WITNESS_EV_MOUSE && e->from_touch) return; /* replay recreates it from the touch */
    q = WITNESS__CAST(witness_event *, witness__grow(witness__g.rec_events, &witness__g.rec_cap, witness__g.rec_len + 1, sizeof(witness_event)));
    if (!q) return;
    witness__g.rec_events = q;
    q[witness__g.rec_len++] = *e;
}

void witness_record_key(const char *key, int down) {
    witness_event e;
    if (!witness__g.rec) return;
    memset(&e, 0, sizeof e);
    e.type = WITNESS_EV_KEY;
    e.down = down ? 1 : 0;
    e.button = -1;
    witness_key_normalize(key, e.name, sizeof e.name);
    witness_record_event(&e);
}

void witness_record_mouse(double x, double y, int button, int down) {
    witness_event e;
    if (!witness__g.rec) return;
    memset(&e, 0, sizeof e);
    e.type = WITNESS_EV_MOUSE;
    e.has_pos = 1;
    e.x = x;
    e.y = y;
    e.button = button;
    e.down = button >= 0 ? (down ? 1 : 0) : -1;
    witness_record_event(&e);
}

void witness_record_touch(int id, double x, double y, int phase) {
    witness_record_touch_ex(id, x, y, phase, 0);
}

void witness_record_touch_ex(int id, double x, double y, int phase, double pressure) {
    witness_event e;
    if (!witness__g.rec) return;
    memset(&e, 0, sizeof e);
    e.type = WITNESS_EV_TOUCH;
    e.id = id;
    e.has_pos = 1;
    e.x = x;
    e.y = y;
    e.phase = phase == WITNESS_TOUCH_DOWN || phase == WITNESS_TOUCH_UP || phase == WITNESS_TOUCH_CANCEL ? phase : WITNESS_TOUCH_MOVE;
    e.down = e.phase == WITNESS_TOUCH_DOWN ? 1 : e.phase == WITNESS_TOUCH_MOVE ? -1 : 0;
    e.button = -1;
    e.pressure = pressure > 0 ? (pressure < 1 ? pressure : 1) : 1;
    witness_record_event(&e);
}

void witness_record_frame(double dt) {
    witness_json *w = &witness__g.rec_line;
    size_t i;
    if (!witness__g.rec) return;
    witness__jw_clear(w);
    witness_json_begin_object(w);
    witness_json_field_int(w, "f", witness__g.rec_frame);
    witness_json_field_number(w, "dt", dt);
    if (witness__g.rec_len) {
        witness_json_key(w, "in");
        witness_json_begin_array(w);
        for (i = 0; i < witness__g.rec_len; i++) witness__write_event(w, &witness__g.rec_events[i]);
        witness_json_end_array(w);
    }
    if (witness__g.rec_mark[0]) witness_json_field_string(w, "mark", witness__g.rec_mark);
    witness_json_end_object(w);
    if (!w->failed) {
        fputs(w->buf, witness__g.rec);
        fputc('\n', witness__g.rec);
        fflush(witness__g.rec);
    }
    witness__g.rec_len = 0;
    witness__g.rec_mark[0] = 0;
    witness__g.rec_frame++;
}

void witness_record_stop(void) {
    if (!witness__g.rec) return;
    fclose(witness__g.rec);
    witness__g.rec = NULL;
}

/* ---------------------------------------------------------------- shutdown */

void witness_shutdown(void) {
    size_t i;
    witness__disconnect();
    witness_record_stop();
#if defined(_WIN32) && !defined(WITNESS_WEB_BRIDGE)
    if (witness__g.wsa_started) WSACleanup();
    witness__g.wsa_started = 0;
#endif
    witness__lock();
    for (i = 0; i < witness__g.log_len; i++) free(witness__g.logs[i].message);
    free(witness__g.logs);
    free(witness__g.audio);
    witness__g.logs = NULL; witness__g.log_len = witness__g.log_cap = 0;
    witness__g.audio = NULL; witness__g.audio_cap = witness__g.audio_len = witness__g.audio_head = 0;
    witness__unlock();
    free(witness__g.in); free(witness__g.out.buf); free(witness__g.rec_line.buf); free(witness__g.sound_line.buf);
    free(witness__g.parser.nodes); free(witness__g.values);
    free(witness__g.queue); free(witness__g.cur); free(witness__g.pixels); free(witness__g.rec_events);
    witness__g.in = NULL; witness__g.in_len = witness__g.in_cap = 0;
    memset(&witness__g.out, 0, sizeof witness__g.out);
    memset(&witness__g.rec_line, 0, sizeof witness__g.rec_line);
    memset(&witness__g.sound_line, 0, sizeof witness__g.sound_line);
    witness__g.parser.nodes = NULL; witness__g.parser.cap = 0;
    witness__g.values = NULL; witness__g.values_cap = 0;
    witness__g.queue = NULL; witness__g.queue_len = witness__g.queue_cap = 0;
    witness__g.cur = NULL; witness__g.cur_len = witness__g.cur_cap = 0;
    witness__g.pixels = NULL; witness__g.pixels_cap = 0;
    witness__g.rec_events = NULL; witness__g.rec_len = witness__g.rec_cap = 0;
}

#endif /* WITNESS_IMPLEMENTATION_DONE */
#endif /* WITNESS_IMPLEMENTATION */
