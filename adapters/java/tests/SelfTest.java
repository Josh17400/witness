// Unit checks for Witness.java. Run from adapters/java:
//   javac --release 8 -d build Witness.java tests/SelfTest.java && java -cp build SelfTest
// With WITNESS_RECORD=<file> set it also records a short replay (walk right for 0.5 s, one mark)
// that `witness replay <file>` can play back against any coins example.
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import witness.Witness;

public final class SelfTest {
    private static int failed, passed;

    private static void eq(Object want, Object got, String what) {
        if (want == null ? got == null : want.equals(got)) { passed++; return; }
        failed++;
        System.out.println("FAIL " + what + ": want <" + want + "> got <" + got + ">");
    }

    /** A LibGDX-style vector: public float fields. */
    public static final class Vector2 {
        public float x, y;
        Vector2(float x, float y) { this.x = x; this.y = y; }
    }

    public static final class Sample {
        public int id = 7;
        public Vector2 pos = new Vector2(0.5f, 2);
        public String name = "n";
        public static int ignoredStatic = 1;
    }

    enum Day { FRIDAY }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws IOException {
        // JSON writer
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("a", 1);
        m.put("b", Arrays.asList(1.5, -2L, "x\"y\n"));
        m.put("c", null);
        m.put("d", true);
        eq("{\"a\":1,\"b\":[1.5,-2,\"x\\\"y\\n\"],\"c\":null,\"d\":true}", Witness.Json.write(m), "write basics");
        eq("[\"NaN\",\"Infinity\",\"-Infinity\",0.1,0.1,40]", Witness.Json.write(new Object[] { Double.NaN, Double.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, 0.1, 0.1f, 40.0 }), "write non-finite, float, whole double");
        eq("[1.5,2.5]", Witness.Json.write(new double[] { 1.5, 2.5 }), "primitive arrays");
        eq("\"" + (char) 92 + "u0001" + (char) 92 + "u2028\"", Witness.Json.write("" + (char) 1 + (char) 0x2028), "control and line-separator escapes");
        eq("[3,4]", Witness.Json.write(new Vector2(3, 4)), "vector as array");
        eq("{\"id\":7,\"pos\":[0.5,2],\"name\":\"n\"}", Witness.Json.write(new Sample()), "public fields via reflection");
        eq("\"FRIDAY\"", Witness.Json.write(Day.FRIDAY), "enum as name");

        // JSON reader
        Map<String, Object> o = (Map<String, Object>) Witness.Json.parse(" {\"id\": 3, \"dt\": 1e-2, \"n\": -0.5, \"s\": \"" + (char) 92 + "u00e9\\t\\/\", \"a\": [], \"o\": {}} ");
        eq(3L, o.get("id"), "integer as Long");
        eq(0.01, o.get("dt"), "exponent");
        eq(-0.5, o.get("n"), "negative");
        eq("" + (char) 0xe9 + "\t/", o.get("s"), "escapes");
        eq(0, ((List<Object>) o.get("a")).size(), "empty array");
        eq(0, ((Map<String, Object>) o.get("o")).size(), "empty object");
        eq(9007199254740993L, Witness.Json.parse("9007199254740993"), "big integers stay exact");
        for (String bad : new String[] { "{", "[1,]", "{\"a\" 1}", "tru", "\"abc", "1 2", "-" }) {
            boolean threw = false;
            try { Witness.Json.parse(bad); } catch (IllegalArgumentException e) { threw = true; }
            eq(true, threw, "rejects " + bad);
        }
        String roundTrip = "{\"k\":[1,2.25,\"\\\\\",{\"z\":false}]}";
        eq(roundTrip, Witness.Json.write(Witness.Json.parse(roundTrip)), "round trip");

        // Keys
        eq("left", Witness.Keys.normalize("LeftArrow"), "LeftArrow");
        eq("left", Witness.Keys.normalize("Left"), "LibGDX Left");
        eq("shift", Witness.Keys.normalize("L-Shift"), "LibGDX L-Shift");
        eq("ctrl", Witness.Keys.normalize("L-Ctrl"), "LibGDX L-Ctrl");
        eq("1", Witness.Keys.normalize("NUM_1"), "LibGDX NUM_1");
        eq("1", Witness.Keys.normalize("KEY_1"), "jME KEY_1");
        eq("enter", Witness.Keys.normalize("Return"), "Return");
        eq("d", Witness.Keys.normalize("D"), "plain D");
        eq("f8", Witness.Keys.normalize("F8"), "F8");
        Map<String, Integer> gdx = new HashMap<>();   // stands in for LibGDX Input.Keys.valueOf
        gdx.put("Right", 22);
        gdx.put("L-Shift", 59);
        gdx.put("1", 8);
        gdx.put("A", 29);
        eq(22, Witness.Keys.lookup("right", n -> gdx.getOrDefault(n, -1)), "lookup right");
        eq(59, Witness.Keys.lookup("shift", n -> gdx.getOrDefault(n, -1)), "lookup shift");
        eq(8, Witness.Keys.lookup("1", n -> gdx.getOrDefault(n, -1)), "lookup 1");
        eq(29, Witness.Keys.lookup("a", n -> gdx.getOrDefault(n, -1)), "lookup a");
        eq(-1, Witness.Keys.lookup("nosuchkey", n -> gdx.getOrDefault(n, -1)), "lookup unknown");

        // PCM
        Witness.Pcm pcm = new Witness.Pcm(1000, 1);
        pcm.play(new float[] { 1, 1, 1, 1, 1 });
        pcm.syncTo(0.003);
        eq(3, pcm.drain().samples.length, "drain stops at now");
        pcm.syncTo(0.010);
        Witness.Audio second = pcm.drain();
        eq(7, second.samples.length, "tail + silence");
        eq(1f, second.samples[1], "tail kept");
        eq(0f, second.samples[2], "then silence");
        pcm.write(new float[] { 0.5f, 0.5f }, 0, 2);
        pcm.syncTo(0.011);
        eq(1, pcm.drain().samples.length, "stream writes are kept until synced");
        Witness.Pcm stereo = new Witness.Pcm(100, 2);
        stereo.syncTo(0.05);
        eq(10, stereo.drain().samples.length, "interleaved stereo");

        // Events
        Witness.Event ev = Witness.Event.fromJson((Map<String, Object>) Witness.Json.parse("{\"frame\":30,\"type\":\"mouse\",\"x\":640,\"y\":360,\"button\":2,\"down\":true}"));
        eq(30, ev.frame, "event frame");
        eq(2, ev.button, "event button");
        eq(true, ev.isDown(), "event down");
        eq("{\"type\":\"mouse\",\"x\":640,\"y\":360,\"button\":2,\"down\":true}", Witness.Json.write(ev.toJson(false)), "event replay shape");
        eq(null, Witness.Event.fromJson((Map<String, Object>) Witness.Json.parse("{\"frame\":1,\"type\":\"mouse\",\"x\":5,\"y\":6}")).down, "mouse move has no down");
        eq("a", Witness.Event.fromJson((Map<String, Object>) Witness.Json.parse("{\"frame\":1,\"type\":\"pad\",\"button\":\"a\",\"down\":true}")).padButton, "pad button");

        // Images
        Witness.Image img = Witness.Image.rgba(2, 2, new byte[] { 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4 }, true);
        eq((byte) 3, img.rgba[0], "bottom-up flip");
        Witness.Image big = img.scaled(2);
        eq(4, big.width, "scaled width");
        eq((byte) 3, big.rgba[4], "nearest neighbour");
        eq((byte) 0x11, Witness.Image.argb(1, 1, new int[] { 0x80112233 }).rgba[0], "argb conversion");

        // Inactive = inert; recording only with WITNESS_RECORD
        eq(false, Witness.active(), "inactive without WITNESS_ADDR");
        Witness.info("ignored");
        String record = System.getenv("WITNESS_RECORD");
        if (record != null && !record.isEmpty()) {
            eq(true, Witness.start(new Witness.Hello("SelfTest").fps(60), null) || Witness.recording(), "recording started");
            for (int f = 0; f < 45; f++) {
                List<Witness.Event> evs = f == 0 ? Collections.singletonList(Witness.Event.key("right", true))
                    : f == 30 ? Collections.singletonList(Witness.Event.key("right", false)) : new ArrayList<>();
                if (f == 20) Witness.mark("F8");
                Witness.recordFrame(1.0 / 60, evs);
            }
            Witness.stopRecording();
            List<String> lines = Files.readAllLines(Paths.get(record), StandardCharsets.UTF_8);
            eq(46, lines.size(), "replay has a header + 45 frames");
            Map<String, Object> head = (Map<String, Object>) Witness.Json.parse(lines.get(0));
            eq(1L, head.get("replay"), "replay header");
            eq((long) Witness.seed(), head.get("seed"), "replay seed");
            eq("F8", ((Map<String, Object>) Witness.Json.parse(lines.get(21))).get("mark"), "mark on frame 20");
            eq("{\"f\":0,\"dt\":0.016666666666666666,\"in\":[{\"type\":\"key\",\"key\":\"right\",\"down\":true}]}", lines.get(1), "frame line shape");
        } else {
            eq(false, Witness.recording(), "not recording without WITNESS_RECORD");
        }

        System.out.println(failed == 0 ? "selftest: all " + passed + " checks passed" : "selftest: " + failed + " FAILED, " + passed + " passed");
        System.exit(failed == 0 ? 0 : 1);
    }
}
