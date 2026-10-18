// The standard Witness sample game ("coins", docs/ADAPTERS.md). Pure simulation: no clock, no
// window, no AWT. Everything advances only through step(dt), so the same seed and inputs always
// give the same state.
package coins;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import witness.Witness;

public final class CoinsGame {
    public static final int WIDTH = 320, HEIGHT = 180, FPS = 60, SAMPLE_RATE = 22050;
    private static final double SPEED = 120, PICKUP_RADIUS = 12;
    private static final float[] DING = makeDing();

    /** A player or a coin. */
    public static final class Entity {
        public final int id;
        public final String type;
        public double x, y;
        final int hp;

        Entity(int id, String type, double x, double y, int hp) {
            this.id = id;
            this.type = type;
            this.x = x;
            this.y = y;
            this.hp = hp;
        }

        Map<String, Object> toJson() {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("id", id);
            o.put("type", type);
            o.put("pos", new double[] { x, y });
            if (hp > 0) o.put("hp", hp);
            return o;
        }
    }

    private final Set<String> held = new HashSet<>();
    private final List<Entity> coins = new ArrayList<>();
    private Entity player;
    private int score;

    public CoinsGame() { reset(1); }

    public void reset(int seed) {
        held.clear();
        coins.clear();
        score = 0;
        player = new Entity(1, "Player", 40, 90, 3);
        for (int i = 0; i < 5; i++) coins.add(new Entity(10 + i, "Coin", 80 + i * 40, i == 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61), 0));
    }

    /** Input arrives through the same path in witness mode and in real-time play. */
    public void apply(Witness.Event e) {
        if ("key".equals(e.type) && e.key != null) {
            if (e.isDown()) held.add(e.key);
            else if (e.isUp()) held.remove(e.key);
        } else if ("action".equals(e.type) && "dash".equals(e.action) && e.isDown()) {
            player.x += 30;
        }
    }

    public void step(double dt) {
        int dx = (held("right", "d") ? 1 : 0) - (held("left", "a") ? 1 : 0);
        int dy = (held("down", "s") ? 1 : 0) - (held("up", "w") ? 1 : 0);
        player.x = Math.max(0, Math.min(WIDTH, player.x + dx * SPEED * dt));
        player.y = Math.max(0, Math.min(HEIGHT, player.y + dy * SPEED * dt));
        for (Entity c : new ArrayList<>(coins)) {
            if (Math.hypot(c.x - player.x, c.y - player.y) >= PICKUP_RADIUS) continue;
            coins.remove(c);
            score++;
            Witness.info("coin " + c.id + " collected");
            Witness.Pcm pcm = Witness.pcm();
            if (pcm != null) pcm.play(DING);
        }
    }

    public Object snapshot() {
        List<Object> entities = new ArrayList<>();
        entities.add(player.toJson());
        for (Entity c : coins) entities.add(c.toJson());
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("score", score);
        s.put("scene", "level1");
        s.put("player", player.toJson());
        s.put("entities", entities);
        return s;
    }

    public Object call(String name, List<Object> args) {
        switch (name) {
            case "teleport":
                player.x = arg(args, 0);
                player.y = arg(args, 1);
                return new double[] { player.x, player.y };
            case "addcoin":
                coins.add(new Entity(100 + coins.size(), "Coin", arg(args, 0), arg(args, 1), 0));
                return coins.size();
            default:
                throw new IllegalArgumentException("unknown call '" + name + "' (try teleport x y, addcoin x y)");
        }
    }

    public int score() { return score; }
    public int coinsLeft() { return coins.size(); }

    /** 320x180 RGBA, top-down: dark background, yellow coins, blue player. */
    public Witness.Image render() {
        byte[] px = new byte[WIDTH * HEIGHT * 4];
        for (int i = 0; i < WIDTH * HEIGHT; i++) put(px, i, 20, 24, 40);
        for (Entity c : coins) blob(px, c.x, c.y, 5, 255, 210, 60);
        blob(px, player.x, player.y, 7, 80, 200, 255);
        return Witness.Image.rgba(WIDTH, HEIGHT, px, false);
    }

    private boolean held(String a, String b) { return held.contains(a) || held.contains(b); }

    private static double arg(List<Object> args, int i) {
        if (args == null || i >= args.size()) throw new IllegalArgumentException("expected 2 numbers: x y");
        double v = Witness.Json.toDouble(args.get(i), Double.NaN);
        if (Double.isNaN(v)) throw new IllegalArgumentException("'" + args.get(i) + "' is not a number");
        return v;
    }

    private static void blob(byte[] px, double cx, double cy, int r, int red, int green, int blue) {
        long ox = Math.round(cx), oy = Math.round(cy);   // same rounding as JavaScript's Math.round
        for (int y = -r; y <= r; y++) {
            for (int x = -r; x <= r; x++) {
                if (x * x + y * y > r * r) continue;
                long tx = ox + x, ty = oy + y;
                if (tx < 0 || ty < 0 || tx >= WIDTH || ty >= HEIGHT) continue;
                put(px, (int) (ty * WIDTH + tx), red, green, blue);
            }
        }
    }

    private static void put(byte[] px, int pixel, int r, int g, int b) {
        int i = pixel * 4;
        px[i] = (byte) r;
        px[i + 1] = (byte) g;
        px[i + 2] = (byte) b;
        px[i + 3] = (byte) 255;
    }

    // A 0.15 s 880 Hz sine with a fast exponential decay.
    private static float[] makeDing() {
        int n = (int) (SAMPLE_RATE * 0.15);
        float[] s = new float[n];
        for (int i = 0; i < n; i++) s[i] = (float) (Math.sin(2 * Math.PI * 880 * i / SAMPLE_RATE) * 0.5 * Math.exp(-i / (SAMPLE_RATE * 0.04)));
        return s;
    }
}
