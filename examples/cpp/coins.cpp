// coins.cpp - the standard Witness sample game, wired through witness.h's C++ layer.
//
//   witness mode (WITNESS_ADDR set, or --witness): the game steps only when told to, with a
//     fixed dt, renders on demand, and mixes audio into the capture buffer per step.
//   normal mode: a 2-second real-time demo with a scripted "player" (this example has no
//     window). With WITNESS_RECORD=<file.jsonl> set it records a replay, F8 mark included,
//     that `witness replay` reproduces exactly.
#include "witness.h"
#include "coins_game.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {

coins_game game;

void log_collect(void *, int coin_id) {
    witness_log(WITNESS_INFO, "coin %d collected", coin_id);
    witness::sound("coin");
}

void write_entity(witness::Json &j, int id, const char *type, double x, double y) {
    j.begin_object().field("id", id).field("type", type).key("pos").vec(x, y);
}

int run_witness() {
    static const witness_call_info calls[] = {
        {"teleport", "x y", "move the player"},
        {"addcoin", "x y", "add a coin, returns the coin count"},
    };
    static const char *const keys[] = {"left", "right", "up", "down", "a", "d", "w", "s"};

    witness_hello hello = witness_hello();
    hello.name = "Coins (C++)";
    hello.engine = "witness.h sample";
    hello.language = "c++";
    hello.fps = COINS_FPS;
    hello.width = COINS_W;
    hello.height = COINS_H;
    hello.calls = calls;
    hello.call_count = 2;
    hello.keys = keys;
    hello.key_count = 8;
    hello.audio_sample_rate = COINS_SAMPLE_RATE;
    hello.audio_channels = 1;

    std::vector<float> mix; // per-step mixer output, reused

    witness::Handlers h;
    h.reset = [](long long seed, const char *, witness::Value) { coins_reset(&game, seed); };
    h.input = [](const witness_event &e) {
        if (e.type == WITNESS_EV_KEY) coins_key(&game, e.name, e.down);
        else if (e.type == WITNESS_EV_ACTION) coins_action(&game, e.name, e.down);
    };
    h.step = [&mix](double dt) {
        coins_step(&game, dt);
        // Render exactly the samples this step covers into a buffer instead of the device.
        int n = witness_audio_frames_for_step(dt);
        mix.resize(static_cast<size_t>(n));
        coins_mix(&game, mix.data(), n);
        witness_audio_write(mix.data(), n);
    };
    h.snapshot = [](witness::Json &j) {
        j.begin_object().field("score", game.score).field("scene", "level1");
        j.key("player");
        write_entity(j, 1, "Player", game.px, game.py);
        j.field("hp", game.hp).end_object();
        j.key("entities").begin_array();
        write_entity(j, 1, "Player", game.px, game.py);
        j.field("hp", game.hp).end_object();
        for (int i = 0; i < game.coin_count; i++) {
            write_entity(j, game.coins[i].id, "Coin", game.coins[i].x, game.coins[i].y);
            j.end_object();
        }
        j.end_array().end_object();
    };
    h.screenshot = [](witness_image &img) -> bool {
        coins_render(&game);
        img.rgba = game.pixels;
        img.width = COINS_W;
        img.height = COINS_H;
        return true;
    };
    h.call = [](const char *name, witness::Value args, witness::Json &result) {
        if (std::strcmp(name, "teleport") == 0) {
            game.px = args[0].num(game.px);
            game.py = args[1].num(game.py);
            result.vec(game.px, game.py);
        } else if (std::strcmp(name, "addcoin") == 0) {
            int count = coins_add_coin(&game, args[0].num(), args[1].num());
            if (count < 0) witness::fail("too many coins");
            else result.value(count);
        } else {
            witness::fail(std::string("unknown call '") + name + "' (try teleport, addcoin)");
        }
    };
    h.perf = [](witness::Json &j) { j.key("counts").begin_object().field("coins", game.coin_count).end_object(); };

    game.on_collect = log_collect;
    coins_reset(&game, 1);
    if (!witness::connect(hello, h)) return 1;
    witness_run();
    witness_shutdown();
    return 0;
}

// Normal play. A real game would pump window events here; this one scripts a short session.
int run_demo() {
    using clock = std::chrono::steady_clock;
    const bool recording = witness_record_start("Coins (C++)", COINS_FPS) != 0;
    coins_reset(&game, witness_seed());

    auto last = clock::now();
    double t = 0;
    bool holding = false, marked = false;
    while (t < 2.0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(16)); // real time: fine outside witness mode
        auto now = clock::now();
        double dt = std::chrono::duration<double>(now - last).count();
        last = now;
        if (dt > 0.1) dt = 0.1;

        // "player": hold right from 0 s to 1.2 s, press F8 at 0.5 s
        if (!holding && t < 1.2) { holding = true; coins_key(&game, "right", 1); witness_record_key("right", 1); }
        if (holding && t >= 1.2) { holding = false; coins_key(&game, "right", 0); witness_record_key("right", 0); }
        if (!marked && t >= 0.5) { marked = true; witness_record_key("f8", 1); witness_record_key("f8", 0); }

        coins_step(&game, dt);
        witness_record_frame(dt);
        t += dt;
    }
    witness_record_stop();
    std::printf("demo finished: t=%.3fs seed=%lld score=%d player=(%.4f, %.4f) coins=%d\n", t, witness_seed(), game.score,
                game.px, game.py, game.coin_count);
    std::printf(recording ? "replay recorded (play it back with: witness replay last)\n"
                          : "tip: set WITNESS_RECORD=witness/replays/demo.jsonl to record a replay; run 'witness test' to verify\n");
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    return witness::active(argc, argv) ? run_witness() : run_demo();
}
