/* coins_c.c - the standard Witness sample game through witness.h's plain C API (C99).
 * Same simulation as coins.cpp (coins_game.h); this file also compiles the implementation.
 * Witness-only: without WITNESS_ADDR / --witness it prints how to run it and exits. */
#define WITNESS_IMPLEMENTATION
#include "witness.h"
#include "coins_game.h"

#include <stdio.h>
#include <string.h>

static coins_game game;
static float mix[COINS_SAMPLE_RATE]; /* one step never needs more than a second of audio */

static void log_collect(void *user, int coin_id) {
    (void)user;
    witness_log(WITNESS_INFO, "coin %d collected", coin_id);
    witness_sound("coin");
}

static int on_reset(void *user, long long seed, const char *scene, const witness_value *params) {
    (void)user; (void)scene; (void)params;
    coins_reset(&game, seed);
    return 1;
}

static void on_input(void *user, const witness_event *e) {
    (void)user;
    if (e->type == WITNESS_EV_KEY) coins_key(&game, e->name, e->down);
    else if (e->type == WITNESS_EV_ACTION) coins_action(&game, e->name, e->down);
}

static void on_step(void *user, double dt) {
    int n;
    (void)user;
    coins_step(&game, dt);
    n = witness_audio_frames_for_step(dt);
    if (n > COINS_SAMPLE_RATE) n = COINS_SAMPLE_RATE;
    coins_mix(&game, mix, n);
    witness_audio_write(mix, n);
}

static void write_entity(witness_json *w, int id, const char *type, double x, double y) {
    witness_json_begin_object(w);
    witness_json_field_int(w, "id", id);
    witness_json_field_string(w, "type", type);
    witness_json_key(w, "pos");
    witness_json_vec2(w, x, y);
}

static void on_snapshot(void *user, witness_json *w, const witness_value *paths) {
    int i;
    (void)user; (void)paths;
    witness_json_begin_object(w);
    witness_json_field_int(w, "score", game.score);
    witness_json_field_string(w, "scene", "level1");
    witness_json_key(w, "player");
    write_entity(w, 1, "Player", game.px, game.py);
    witness_json_field_int(w, "hp", game.hp);
    witness_json_end_object(w);
    witness_json_key(w, "entities");
    witness_json_begin_array(w);
    write_entity(w, 1, "Player", game.px, game.py);
    witness_json_field_int(w, "hp", game.hp);
    witness_json_end_object(w);
    for (i = 0; i < game.coin_count; i++) {
        write_entity(w, game.coins[i].id, "Coin", game.coins[i].x, game.coins[i].y);
        witness_json_end_object(w);
    }
    witness_json_end_array(w);
    witness_json_end_object(w);
}

static int on_screenshot(void *user, witness_image *img) {
    (void)user;
    coins_render(&game);
    img->rgba = game.pixels;
    img->width = COINS_W;
    img->height = COINS_H;
    return 1;
}

static int on_call(void *user, const char *name, const witness_value *args, witness_json *result) {
    (void)user;
    if (strcmp(name, "teleport") == 0) {
        game.px = witness_number(witness_at(args, 0), game.px);
        game.py = witness_number(witness_at(args, 1), game.py);
        witness_json_vec2(result, game.px, game.py);
        return 1;
    }
    if (strcmp(name, "addcoin") == 0) {
        int count = coins_add_coin(&game, witness_number(witness_at(args, 0), 0), witness_number(witness_at(args, 1), 0));
        if (count < 0) { witness_error("too many coins"); return 0; }
        witness_json_int(result, count);
        return 1;
    }
    witness_error("unknown call '%s' (try teleport, addcoin)", name);
    return 0;
}

static void on_perf(void *user, witness_json *w) {
    (void)user;
    witness_json_key(w, "counts");
    witness_json_begin_object(w);
    witness_json_field_int(w, "coins", game.coin_count);
    witness_json_end_object(w);
}

int main(int argc, char **argv) {
    static const witness_call_info calls[] = {
        {"teleport", "x y", "move the player"},
        {"addcoin", "x y", "add a coin, returns the coin count"},
    };
    witness_hello hello;
    witness_handlers h;

    if (!witness_active(argc, argv)) {
        printf("coins_c is witness-only: run it through the CLI, e.g. witness test --cmd \"%s\"\n", argv[0]);
        return 0;
    }
    memset(&hello, 0, sizeof hello);
    hello.name = "Coins (C)";
    hello.engine = "witness.h sample";
    hello.language = "c";
    hello.fps = COINS_FPS;
    hello.width = COINS_W;
    hello.height = COINS_H;
    hello.calls = calls;
    hello.call_count = 2;
    hello.audio_sample_rate = COINS_SAMPLE_RATE;
    hello.audio_channels = 1;

    memset(&h, 0, sizeof h);
    h.reset = on_reset;
    h.input = on_input;
    h.step = on_step;
    h.snapshot = on_snapshot;
    h.screenshot = on_screenshot;
    h.call = on_call;
    h.perf = on_perf;

    game.on_collect = log_collect;
    coins_reset(&game, 1);
    if (!witness_connect(&hello, &h)) return 1;
    witness_run();
    witness_shutdown();
    return 0;
}
