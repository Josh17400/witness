/* coins_game.h - the standard Witness sample game ("coins") as a pure simulation.
 *
 * No window, no clock, no globals, no Witness calls: just state + fixed-dt step, a software
 * rasterizer (the "view") and a tiny synth (the "mixer"). Both front-ends share it:
 *   coins.cpp   - wires it to Witness through the C++ layer (witness::Handlers)
 *   coins_c.c   - wires it through the plain C API
 * Spec: docs/ADAPTERS.md, "The standard sample game". Mirrors tests/mock-game.mjs. */
#ifndef COINS_GAME_H
#define COINS_GAME_H

#include <math.h>
#include <string.h>

#define COINS_W 320
#define COINS_H 180
#define COINS_FPS 60
#define COINS_SAMPLE_RATE 22050
#define COINS_MAX 256
#define COINS_MAX_VOICES 16
#define COINS_SPEED 120.0
#define COINS_PI 3.14159265358979323846

#if defined(_MSC_VER) && !defined(__cplusplus)
#define COINS_INLINE static __inline
#else
#define COINS_INLINE static inline
#endif

typedef struct coins_coin {
    int id;
    double x, y;
} coins_coin;

typedef void (*coins_log_fn)(void *user, int coin_id);

typedef struct coins_game {
    long long seed;
    double px, py; /* player */
    int hp, score;
    coins_coin coins[COINS_MAX];
    int coin_count;
    /* input state, fed through coins_key() by whatever drives the game */
    int right, left, up, down, d, a, s, w;
    /* mixer: active "ding" voices, by age in samples */
    long voice_age[COINS_MAX_VOICES];
    int voice_count;
    /* view */
    unsigned char pixels[COINS_W * COINS_H * 4];
    /* collected-coin notification (the front-end turns it into a log line) */
    coins_log_fn on_collect;
    void *user;
} coins_game;

COINS_INLINE void coins_reset(coins_game *g, long long seed) {
    int i;
    g->seed = seed;
    g->px = 40;
    g->py = 90;
    g->hp = 3;
    g->score = 0;
    g->right = g->left = g->up = g->down = g->d = g->a = g->s = g->w = 0;
    g->voice_count = 0;
    g->coin_count = 5;
    for (i = 0; i < 5; i++) {
        g->coins[i].id = 10 + i;
        g->coins[i].x = 80 + 40 * i;
        g->coins[i].y = i == 0 ? 90 : 60 + (double)((seed * 7 + i * 13) % 61);
    }
}

/* The game's normal input path: a named key went down or up. Unknown keys are ignored. */
COINS_INLINE void coins_key(coins_game *g, const char *key, int down) {
    int *slot = NULL;
    if (strcmp(key, "right") == 0) slot = &g->right;
    else if (strcmp(key, "left") == 0) slot = &g->left;
    else if (strcmp(key, "up") == 0) slot = &g->up;
    else if (strcmp(key, "down") == 0) slot = &g->down;
    else if (strcmp(key, "d") == 0) slot = &g->d;
    else if (strcmp(key, "a") == 0) slot = &g->a;
    else if (strcmp(key, "s") == 0) slot = &g->s;
    else if (strcmp(key, "w") == 0) slot = &g->w;
    if (slot) *slot = down ? 1 : 0;
}

/* Input-mapping actions: "dash" jumps 30 px right (as in the reference mock). */
COINS_INLINE void coins_action(coins_game *g, const char *action, int down) {
    if (down && strcmp(action, "dash") == 0) g->px += 30;
}

COINS_INLINE double coins_clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

COINS_INLINE void coins_step(coins_game *g, double dt) {
    int dx = ((g->right || g->d) ? 1 : 0) - ((g->left || g->a) ? 1 : 0);
    int dy = ((g->down || g->s) ? 1 : 0) - ((g->up || g->w) ? 1 : 0);
    int i = 0;
    g->px = coins_clamp(g->px + dx * COINS_SPEED * dt, 0, COINS_W);
    g->py = coins_clamp(g->py + dy * COINS_SPEED * dt, 0, COINS_H);
    while (i < g->coin_count) {
        coins_coin c = g->coins[i];
        if (hypot(c.x - g->px, c.y - g->py) < 12) {
            memmove(&g->coins[i], &g->coins[i + 1], (size_t)(g->coin_count - i - 1) * sizeof(coins_coin));
            g->coin_count--;
            g->score++;
            if (g->voice_count < COINS_MAX_VOICES) g->voice_age[g->voice_count++] = 0;
            if (g->on_collect) g->on_collect(g->user, c.id);
        } else {
            i++;
        }
    }
}

COINS_INLINE int coins_add_coin(coins_game *g, double x, double y) {
    if (g->coin_count >= COINS_MAX) return -1;
    g->coins[g->coin_count].id = 100 + g->coin_count;
    g->coins[g->coin_count].x = x;
    g->coins[g->coin_count].y = y;
    return ++g->coin_count;
}

/* Mixer: render `frames` mono samples. A ding is a 0.15 s 880 Hz decaying sine. */
COINS_INLINE void coins_mix(coins_game *g, float *out, int frames) {
    const long len = (long)(COINS_SAMPLE_RATE * 0.15);
    int i, v;
    for (i = 0; i < frames; i++) {
        double s = 0;
        for (v = 0; v < g->voice_count; v++) {
            long age = g->voice_age[v]++;
            if (age <= len) s += sin(2 * COINS_PI * 880 * age / COINS_SAMPLE_RATE) * 0.5 * exp(-age / (COINS_SAMPLE_RATE * 0.04));
        }
        out[i] = (float)s;
    }
    for (v = 0; v < g->voice_count;) { /* retire finished voices */
        if (g->voice_age[v] > len) g->voice_age[v] = g->voice_age[--g->voice_count];
        else v++;
    }
}

/* View: dark background, yellow coins, blue player. Fills g->pixels (RGBA, top-down). */
COINS_INLINE void coins_put(coins_game *g, int x, int y, int r, int gr, int b) {
    unsigned char *p;
    if (x < 0 || y < 0 || x >= COINS_W || y >= COINS_H) return;
    p = g->pixels + (y * COINS_W + x) * 4;
    p[0] = (unsigned char)r; p[1] = (unsigned char)gr; p[2] = (unsigned char)b; p[3] = 255;
}

COINS_INLINE void coins_disc(coins_game *g, double cx, double cy, int radius, int r, int gr, int b) {
    int x, y, ox = (int)floor(cx + 0.5), oy = (int)floor(cy + 0.5);
    for (y = -radius; y <= radius; y++)
        for (x = -radius; x <= radius; x++)
            if (x * x + y * y <= radius * radius) coins_put(g, ox + x, oy + y, r, gr, b);
}

COINS_INLINE void coins_render(coins_game *g) {
    int i;
    for (i = 0; i < COINS_W * COINS_H; i++) {
        g->pixels[i * 4 + 0] = 20; g->pixels[i * 4 + 1] = 24; g->pixels[i * 4 + 2] = 40; g->pixels[i * 4 + 3] = 255;
    }
    for (i = 0; i < g->coin_count; i++) coins_disc(g, g->coins[i].x, g->coins[i].y, 5, 255, 210, 60);
    coins_disc(g, g->px, g->py, 7, 80, 200, 255);
}

#endif /* COINS_GAME_H */
