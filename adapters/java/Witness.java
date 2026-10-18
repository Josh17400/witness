// Witness.java: the Witness adapter for Java and Kotlin (protocol v1, docs/PROTOCOL.md).
//
// One file, Java 8+, no dependencies: TCP client, JSON reader/writer, base64 helpers, a PCM capture
// buffer, a replay recorder (WITNESS_RECORD) and key-name mapping. Works with plain Java2D/Swing,
// LibGDX, LWJGL, jMonkeyEngine and Kotlin (call it as Witness.start(...), Witness.Handlers(), ...).
//
// Zero cost when inactive: nothing connects, no thread starts and nothing allocates unless
// WITNESS_ADDR is set (or -Dwitness / --witness is given) or WITNESS_RECORD is set.
//
//   Witness.Hello hello = new Witness.Hello("My Game").engine("LibGDX").fps(60).size(320, 180);
//   Witness.Handlers h = new Witness.Handlers()
//       .reset((seed, scene, params) -> game.reset(seed))
//       .input(game::apply)              // a Witness.Event, at the start of its frame
//       .step(game::update)              // exactly one fixed frame of dt seconds
//       .snapshot(game::state);          // Maps / Lists / numbers / strings
//   if (Witness.start(hello, h)) { Witness.run(h); return; }
//   // ...otherwise the normal real-time loop (call Witness.recordFrame(dt, events) once per frame)
//
// Engines that own the frame loop use the lower-level pieces: next()/tryNext(), handle(cmd, h),
// cmd.reply(...), beginFrame()/endFrame(dt).
package witness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.DoubleConsumer;
import java.util.function.DoubleFunction;
import java.util.function.Function;
import java.util.function.Supplier;

public final class Witness {
    public static final int PROTOCOL = 1;
    public static final String DEFAULT_ADDRESS = "127.0.0.1:7357";

    private Witness() {}

    // ================================================================== data types

    /** A custom command advertised in the hello ({@code witness call name args}). */
    public static final class Call {
        public final String name, args, help;
        public Call(String name, String args, String help) { this.name = name; this.args = args; this.help = help; }
    }

    /** The handshake sent on connect (protocol section 2). Fluent setters, or set the fields. */
    public static final class Hello {
        public String name = "game", engine = "custom", language = "java";
        public int fps = 60, width, height;
        public final List<Call> calls = new ArrayList<>();
        /** Optional: the Witness key names the game actually uses. */
        public List<String> keys;
        /** Leave null to derive it from the handlers that are set. */
        public List<String> capabilities;

        public Hello() {}
        public Hello(String name) { this.name = name; }
        public Hello engine(String v) { engine = v; return this; }
        public Hello language(String v) { language = v; return this; }
        public Hello fps(int v) { fps = v; return this; }
        public Hello size(int w, int h) { width = w; height = h; return this; }
        public Hello call(String name, String args, String help) { calls.add(new Call(name, args, help)); return this; }
        public Hello keys(String... names) { keys = Arrays.asList(names); return this; }
        public Hello capabilities(String... caps) { capabilities = Arrays.asList(caps); return this; }
    }

    /** One input event (protocol section 4). Unused fields keep their defaults. */
    public static final class Event {
        public int frame;
        /** key | mouse | wheel | text | action | pad | axis (or anything the game understands). */
        public String type = "";
        public String key, text, action, axis;
        /** Pad button name ("a", "start", ...). Mouse buttons use {@link #button}. */
        public String padButton;
        /** null for events without a down/up meaning (mouse moves, wheel, text, axis). */
        public Boolean down;
        public double x, y, dx, dy, value;
        /** Mouse: 0 left, 1 middle, 2 right. */
        public int button;
        /** The event exactly as received, including fields this class doesn't model. */
        public Map<String, Object> raw;

        public boolean isDown() { return Boolean.TRUE.equals(down); }
        public boolean isUp() { return Boolean.FALSE.equals(down); }

        public static Event key(String key, boolean down) {
            Event e = new Event();
            e.type = "key";
            e.key = key;
            e.down = down;
            return e;
        }

        public static Event fromJson(Map<String, Object> o) {
            Event e = new Event();
            e.raw = o;
            e.frame = (int) Json.toLong(o.get("frame"), 0);
            e.type = Json.str(o.get("type"), "");
            e.key = Json.str(o.get("key"), null);
            Object down = o.get("down");
            if (down instanceof Boolean) e.down = (Boolean) down;
            e.x = Json.toDouble(o.get("x"), 0);
            e.y = Json.toDouble(o.get("y"), 0);
            Object button = o.get("button");
            if (button instanceof String) e.padButton = (String) button;
            else e.button = (int) Json.toLong(button, 0);
            e.dx = Json.toDouble(o.get("dx"), 0);
            e.dy = Json.toDouble(o.get("dy"), 0);
            e.text = Json.str(o.get("text"), null);
            e.action = Json.str(o.get("action"), null);
            e.axis = Json.str(o.get("axis"), null);
            e.value = Json.toDouble(o.get("value"), 0);
            return e;
        }

        /** The protocol shape. Replays omit the frame (it is the line's "f"). */
        public Map<String, Object> toJson(boolean includeFrame) {
            Map<String, Object> o = new LinkedHashMap<>();
            if (includeFrame) o.put("frame", frame);
            o.put("type", type);
            switch (type) {
                case "key": o.put("key", key); break;
                case "mouse": o.put("x", x); o.put("y", y); if (down != null) o.put("button", button); break;
                case "wheel": if (dx != 0) o.put("dx", dx); o.put("dy", dy); break;
                case "text": o.put("text", text); break;
                case "action": o.put("action", action); break;
                case "pad": o.put("button", padButton); break;
                case "axis": o.put("axis", axis); o.put("value", value); break;
                default:
                    if (raw != null) for (Map.Entry<String, Object> kv : raw.entrySet()) if (!kv.getKey().equals("frame")) o.put(kv.getKey(), kv.getValue());
            }
            if (down != null) o.put("down", down);
            return o;
        }

        @Override public String toString() { return Json.write(toJson(true)); }
    }

    /** A screenshot: raw RGBA (top-to-bottom rows), an encoded PNG, or a file path. */
    public static final class Image {
        public int width, height;
        public byte[] rgba, png;
        public String path;

        public static Image rgba(int width, int height, byte[] rgba, boolean bottomUp) {
            if (rgba == null || rgba.length < width * height * 4) throw new IllegalArgumentException("rgba must hold width*height*4 bytes");
            Image i = new Image();
            i.width = width;
            i.height = height;
            i.rgba = bottomUp ? flipRows(rgba, width, height) : rgba;
            return i;
        }

        public static Image png(byte[] png, int width, int height) { Image i = new Image(); i.png = png; i.width = width; i.height = height; return i; }
        public static Image file(String path, int width, int height) { Image i = new Image(); i.path = path; i.width = width; i.height = height; return i; }

        /** Packed ARGB ints (BufferedImage.getRGB, Pixmap after conversion) to RGBA bytes. */
        public static Image argb(int width, int height, int[] argb) {
            byte[] o = new byte[width * height * 4];
            for (int p = 0; p < width * height; p++) {
                int c = argb[p];
                o[p * 4] = (byte) (c >> 16);
                o[p * 4 + 1] = (byte) (c >> 8);
                o[p * 4 + 2] = (byte) c;
                o[p * 4 + 3] = (byte) (c >>> 24);
            }
            return rgba(width, height, o, false);
        }

        /** GL readbacks (LibGDX ScreenUtils.getFrameBufferPixels(false), glReadPixels) are bottom-up. */
        public static byte[] flipRows(byte[] rgba, int width, int height) {
            int stride = width * 4;
            byte[] o = new byte[stride * height];
            for (int y = 0; y < height; y++) System.arraycopy(rgba, y * stride, o, (height - 1 - y) * stride, stride);
            return o;
        }

        /** Nearest-neighbour resize (used for the screenshot "scale" argument). */
        public Image scaled(double scale) {
            if (rgba == null || scale <= 0 || Math.abs(scale - 1) < 1e-9) return this;
            int w = Math.max(1, (int) Math.round(width * scale)), h = Math.max(1, (int) Math.round(height * scale));
            byte[] o = new byte[w * h * 4];
            for (int y = 0; y < h; y++) {
                int sy = Math.min(height - 1, (int) (y / scale));
                for (int x = 0; x < w; x++) System.arraycopy(rgba, (sy * width + Math.min(width - 1, (int) (x / scale))) * 4, o, (y * w + x) * 4, 4);
            }
            return rgba(w, h, o, false);
        }
    }

    /** Interleaved float PCM in [-1, 1]. */
    public static final class Audio {
        public final int sampleRate, channels;
        public final float[] samples;
        public Audio(int sampleRate, int channels, float[] samples) { this.sampleRate = sampleRate; this.channels = channels; this.samples = samples; }
    }

    /**
     * Captures the game's audio in witness mode, synchronized with simulated time: after a frame
     * ends at time t the buffer holds exactly round(t * sampleRate) frames. play() mixes a sound
     * starting "now"; write() appends a continuous stream (an engine mixer). Thread-safe.
     */
    public static final class Pcm {
        public final int sampleRate, channels;
        private float[] buf = new float[4096];
        private int len;          // samples buffered
        private long origin;      // absolute frame index of buf[0]
        private long cursor;      // absolute frame index of "now"

        public Pcm(int sampleRate, int channels) {
            if (sampleRate <= 0 || channels <= 0) throw new IllegalArgumentException("sampleRate and channels must be positive");
            this.sampleRate = sampleRate;
            this.channels = channels;
        }

        /** Mixes interleaved samples into the buffer starting at the current simulated time. */
        public synchronized void play(float[] samples, float gain) {
            int start = (int) Math.max(0, (cursor - origin) * channels);
            ensure(start + samples.length);
            for (int i = 0; i < samples.length; i++) buf[start + i] += samples[i] * gain;
        }

        public void play(float[] samples) { play(samples, 1f); }

        /** Appends interleaved samples after everything already buffered. */
        public synchronized void write(float[] samples, int offset, int count) {
            int at = len;
            ensure(len + count);
            System.arraycopy(samples, offset, buf, at, count);
        }

        /** Advances "now" to simulated time t, padding with silence. Witness.endFrame calls this. */
        public synchronized void syncTo(double time) {
            cursor = Math.round(time * sampleRate);
            ensure((int) ((cursor - origin) * channels));
        }

        /** Takes everything up to "now". Sound ringing past it stays for the next call. */
        public synchronized Audio drain() {
            int n = (int) Math.max(0, Math.min(len, (cursor - origin) * channels));
            float[] o = Arrays.copyOf(buf, n);
            System.arraycopy(buf, n, buf, 0, len - n);
            Arrays.fill(buf, len - n, len, 0f);
            len -= n;
            origin += n / channels;
            return new Audio(sampleRate, channels, o);
        }

        public synchronized void clear() {
            Arrays.fill(buf, 0, len, 0f);
            len = 0;
            origin = 0;
            cursor = 0;
        }

        private void ensure(int n) {
            if (n > buf.length) buf = Arrays.copyOf(buf, Math.max(n, buf.length * 2));
            if (n > len) len = n;   // the grown region is already zero
        }
    }

    @FunctionalInterface
    public interface ResetHandler { void reset(int seed, String scene, Map<String, Object> params); }

    /** Callbacks for the commands the game supports. A null handler means "not supported". */
    public static final class Handlers {
        public ResetHandler reset;
        /** Called for each queued event at the start of its frame, before step. */
        public Consumer<Event> input;
        /** Advance exactly one frame by dt seconds. */
        public DoubleConsumer step;
        /** A JSON-able tree: Maps, Lists/arrays, numbers, strings, booleans, null, vectors. */
        public Supplier<Object> snapshot;
        public DoubleFunction<Image> screenshot;
        /** Optional: by default Witness drains {@link Witness#pcm()}. */
        public Supplier<Audio> audio;
        /** (name, args) to result. Throw to report an error. */
        public BiFunction<String, List<Object>, Object> call;
        public Function<String, Object> eval;
        /** A Map merged into the reply: frame_ms, update_ms, render_ms, counts. */
        public Supplier<Map<String, Object>> perf;
        /** Called after the quit reply is sent. */
        public Runnable quit;

        public Handlers reset(ResetHandler f) { reset = f; return this; }
        public Handlers input(Consumer<Event> f) { input = f; return this; }
        public Handlers step(DoubleConsumer f) { step = f; return this; }
        public Handlers snapshot(Supplier<Object> f) { snapshot = f; return this; }
        public Handlers screenshot(DoubleFunction<Image> f) { screenshot = f; return this; }
        public Handlers audio(Supplier<Audio> f) { audio = f; return this; }
        public Handlers call(BiFunction<String, List<Object>, Object> f) { call = f; return this; }
        public Handlers eval(Function<String, Object> f) { eval = f; return this; }
        public Handlers perf(Supplier<Map<String, Object>> f) { perf = f; return this; }
        public Handlers quit(Runnable f) { quit = f; return this; }
    }

    /** One command from the CLI. Answer it exactly once with reply or fail. */
    public static final class Command {
        public final long id;
        public final String name;
        public final Map<String, Object> args;
        private boolean answered;

        Command(long id, String name, Map<String, Object> args) { this.id = id; this.name = name; this.args = args; }

        public Object get(String key) { return args.get(key); }
        public String string(String key, String fallback) { return Json.str(args.get(key), fallback); }
        public long longValue(String key, long fallback) { return Json.toLong(args.get(key), fallback); }
        public double doubleValue(String key, double fallback) { return Json.toDouble(args.get(key), fallback); }
        @SuppressWarnings("unchecked") public List<Object> list(String key) { Object v = args.get(key); return v instanceof List ? (List<Object>) v : null; }
        @SuppressWarnings("unchecked") public Map<String, Object> map(String key) { Object v = args.get(key); return v instanceof Map ? (Map<String, Object>) v : null; }
        public boolean answered() { return answered; }

        /** Sends {"id", "ok": true, ...fields}; fields may be null. */
        public synchronized void reply(Map<String, ?> fields) {
            if (answered) return;
            answered = true;
            StringBuilder sb = new StringBuilder(64).append("{\"id\":").append(id).append(",\"ok\":true");
            if (fields != null) {
                for (Map.Entry<String, ?> kv : fields.entrySet()) {
                    if (kv.getKey().equals("id") || kv.getKey().equals("ok")) continue;
                    sb.append(',');
                    Json.writeString(sb, kv.getKey());
                    sb.append(':');
                    Json.writeValue(sb, kv.getValue(), 0);
                }
            }
            sendLine(sb.append('}').toString());
        }

        public void reply() { reply(null); }

        public synchronized void fail(String error) {
            if (answered) return;
            answered = true;
            StringBuilder sb = new StringBuilder(64).append("{\"id\":").append(id).append(",\"ok\":false,\"error\":");
            Json.writeString(sb, error == null ? "error" : error);
            sendLine(sb.append('}').toString());
        }
    }

    // ================================================================== state

    private static final Object GATE = new Object();
    private static final Object WRITE_GATE = new Object();
    private static final ArrayDeque<Command> INBOX = new ArrayDeque<>();
    private static final List<Event> PENDING = new ArrayList<>();
    private static final List<Map<String, Object>> LOGS = new ArrayList<>();
    private static volatile List<Event> frameEvents = Collections.emptyList();
    private static Socket socket;
    private static OutputStream out;
    private static volatile boolean connected, quitting;
    private static Boolean active;
    private static int seed = 1;
    private static boolean seedChosen;
    private static int frame;
    private static double time;
    private static Hello hello;
    private static Handlers handlers;
    private static volatile Pcm pcm;
    private static Writer rec;
    private static int recFrame;
    private static String recMark;

    // ================================================================== lifecycle

    /** True in witness mode: WITNESS_ADDR is set, or -Dwitness, or --witness on the command line. */
    public static synchronized boolean active() {
        if (active == null) {
            String addr = env("WITNESS_ADDR");
            String prop = System.getProperty("witness");
            String cmd = System.getProperty("sun.java.command", "");   // HotSpot/OpenJ9: "main.Class arg1 arg2"
            active = (addr != null && !addr.isEmpty()) || (prop != null && !prop.equals("false")) || (" " + cmd + " ").contains(" --witness ");
        }
        return active;
    }

    /** Same as active(), also scanning main's args for --witness. */
    public static synchronized boolean active(String[] args) {
        if (args != null) for (String a : args) if ("--witness".equals(a)) active = true;
        return active();
    }

    public static boolean connected() { return connected; }

    public static String address() {
        String a = env("WITNESS_ADDR");
        return a == null || a.isEmpty() ? DEFAULT_ADDRESS : a;
    }

    /** The simulated frame number (frames stepped since the last reset). */
    public static int frame() { return frame; }

    /** The simulated time in seconds since the last reset. */
    public static double time() { return time; }

    /** Set in witness mode to capture audio (before start, so the hello advertises it). */
    public static void pcm(Pcm p) { pcm = p; }
    public static Pcm pcm() { return pcm; }

    /**
     * The seed for every RNG: the reset seed in witness mode; otherwise WITNESS_SEED or a seed picked
     * once per run (and written to the replay header when recording).
     */
    public static synchronized int seed() {
        if (!seedChosen && !active()) {
            seedChosen = true;
            String env = env("WITNESS_SEED");
            try { seed = env != null ? Integer.parseInt(env.trim()) : (int) (System.currentTimeMillis() % 1000000) + 1; }
            catch (NumberFormatException e) { seed = (int) (System.currentTimeMillis() % 1000000) + 1; }
        }
        return seed;
    }

    /** The events being applied in the current frame. */
    public static List<Event> frameEvents() { return frameEvents; }

    /**
     * The one-call entry point. In witness mode connects and returns true (then call run, or poll).
     * Otherwise starts recording if WITNESS_RECORD is set and returns false.
     */
    public static boolean start(Hello hello, Handlers handlers) {
        if (active()) return connect(hello, handlers);
        startRecording(hello);
        return false;
    }

    /** Connects and sends the hello. Retries for ~3 s. Returns false on failure. */
    public static synchronized boolean connect(Hello h, Handlers hs) {
        if (connected) return true;
        hello = h != null ? h : new Hello();
        handlers = hs;
        String addr = address();
        int colon = addr.lastIndexOf(':');
        int port;
        try { port = Integer.parseInt(addr.substring(colon + 1)); }
        catch (RuntimeException e) { System.err.println("[witness] bad WITNESS_ADDR '" + addr + "' (expected host:port)"); return false; }
        String host = addr.substring(0, Math.max(0, colon));
        IOException last = null;
        for (int attempt = 0; attempt < 30 && socket == null; attempt++) {
            Socket s = new Socket();
            try {
                s.setTcpNoDelay(true);
                s.connect(new InetSocketAddress(host, port), 2000);
                socket = s;
                out = s.getOutputStream();
            } catch (IOException e) {
                last = e;
                try { s.close(); } catch (IOException ignored) { /* never opened */ }
                sleep(100);
            }
        }
        if (socket == null) {
            System.err.println("[witness] could not connect to " + addr + ": " + (last != null ? last.getMessage() : "unknown error"));
            return false;
        }
        connected = true;
        quitting = false;
        sendLine(helloJson(hello, hs));
        Socket connectedSocket = socket;
        Thread reader = new Thread(() -> readLoop(connectedSocket), "witness-reader");
        reader.setDaemon(true);
        reader.start();
        return true;
    }

    /** Owns the loop until the CLI quits or disconnects. */
    public static void run(Handlers h) { while (poll(h)) { /* keep serving */ } }

    /** Waits for one command and handles it. Returns false once the session is over. */
    public static boolean poll(Handlers h) {
        Command c = next(-1);
        if (c == null) return false;
        handle(c, h != null ? h : handlers != null ? handlers : new Handlers());
        return !quitting && connected;
    }

    /** Blocks until a command arrives (timeoutMs &lt; 0: forever). Null on timeout or disconnect. */
    public static Command next(long timeoutMs) {
        long deadline = timeoutMs < 0 ? Long.MAX_VALUE : System.nanoTime() / 1000000 + timeoutMs;
        synchronized (GATE) {
            while (INBOX.isEmpty()) {
                if (!connected) return null;
                long left = deadline - System.nanoTime() / 1000000;
                if (left <= 0) return null;
                try { GATE.wait(Math.min(left, 250)); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); return null; }
            }
            return INBOX.poll();
        }
    }

    /** Non-blocking: for engines that poll once per engine frame. Null when nothing is waiting. */
    public static Command tryNext() {
        synchronized (GATE) { return INBOX.poll(); }
    }

    /** Answers a command with the default behaviour, calling the handlers. Never throws. */
    public static void handle(Command c, Handlers h) {
        try {
            switch (c.name) {
                case "reset": {
                    int s = (int) c.longValue("seed", 1);
                    resetClock(s);
                    if (h.reset != null) h.reset.reset(s, c.string("scene", null), c.map("params"));
                    c.reply();
                    break;
                }
                case "input":
                    queueInput(c.list("events"));
                    c.reply();
                    break;
                case "step":
                    if (h.step == null) { c.fail("this game has no step handler"); break; }
                    for (double dt : stepDts(c)) {
                        List<Event> due = beginFrame();
                        if (h.input != null) for (Event e : due) h.input.accept(e);
                        h.step.accept(dt);
                        endFrame(dt);
                    }
                    c.reply(clock());
                    break;
                case "snapshot": {
                    if (h.snapshot == null) { c.fail("this game has no snapshot handler"); break; }
                    Map<String, Object> r = clock();
                    r.put("state", filterPaths(h.snapshot.get(), c.list("paths")));
                    c.reply(r);
                    break;
                }
                case "screenshot": {
                    if (h.screenshot == null) { c.fail("this game has no screenshot handler"); break; }
                    double scale = c.doubleValue("scale", 1);
                    Image img = h.screenshot.apply(scale);
                    if (img == null) { c.fail("the screenshot handler returned nothing"); break; }
                    c.reply(imageJson(img.scaled(scale)));
                    break;
                }
                case "audio": {
                    Pcm p = pcm;
                    Audio a = h.audio != null ? h.audio.get() : p != null ? p.drain() : null;
                    if (a == null) { c.fail("this game doesn't capture audio (set Witness.pcm(...) or an audio handler)"); break; }
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("sampleRate", a.sampleRate);
                    r.put("channels", a.channels);
                    r.put("format", "f32");
                    r.put("data", base64F32(a.samples));
                    c.reply(r);
                    break;
                }
                case "call": {
                    if (h.call == null) { c.fail("this game has no custom calls"); break; }
                    List<Object> args = c.list("args");
                    c.reply(Collections.singletonMap("result", h.call.apply(c.string("name", ""), args != null ? args : new ArrayList<>())));
                    break;
                }
                case "eval":
                    if (h.eval == null) { c.fail("eval is not supported by this game"); break; }
                    c.reply(Collections.singletonMap("value", h.eval.apply(c.string("expr", ""))));
                    break;
                case "logs":
                    c.reply(Collections.singletonMap("logs", drainLogs()));
                    break;
                case "perf":
                    if (h.perf == null) { c.fail("perf is not supported by this game"); break; }
                    c.reply(h.perf.get());
                    break;
                case "quit":
                    c.reply();
                    quitting = true;
                    disconnect();
                    if (h.quit != null) h.quit.run();
                    break;
                default:
                    c.fail("unknown command '" + c.name + "'");
            }
        } catch (Throwable t) {   // a game bug must become a failed reply, not a dead adapter
            c.fail(t.getClass().getSimpleName() + ": " + t.getMessage());
        }
    }

    // ================================================================== frame clock & input

    /** Resets the frame clock, input queue and audio capture. handle("reset") calls this. */
    public static void resetClock(int newSeed) {
        synchronized (Witness.class) { seed = newSeed; seedChosen = true; }
        frame = 0;
        time = 0;
        synchronized (PENDING) { PENDING.clear(); }
        frameEvents = Collections.emptyList();
        Pcm p = pcm;
        if (p != null) p.clear();
    }

    /** Queues protocol events (the "events" array of an input command). */
    @SuppressWarnings("unchecked")
    public static void queueInput(List<Object> events) {
        if (events == null) return;
        synchronized (PENDING) {
            for (Object o : events) if (o instanceof Map) PENDING.add(Event.fromJson((Map<String, Object>) o));
        }
    }

    /** Starts a frame: removes and returns the queued events due now (frame &lt;= frame()), in arrival order. */
    public static List<Event> beginFrame() {
        List<Event> due = new ArrayList<>();
        synchronized (PENDING) {
            for (Iterator<Event> it = PENDING.iterator(); it.hasNext(); ) {
                Event e = it.next();
                if (e.frame <= frame) { due.add(e); it.remove(); }
            }
        }
        frameEvents = due;
        return due;
    }

    /** The queued events due at the given frame (pull-style input; does not remove them). */
    public static List<Event> inputEvents(int atFrame) {
        List<Event> o = new ArrayList<>();
        synchronized (PENDING) { for (Event e : PENDING) if (e.frame <= atFrame) o.add(e); }
        return o;
    }

    /** Ends a frame of dt seconds: advances frame/time and syncs audio capture. */
    public static void endFrame(double dt) {
        frame++;
        time += dt;
        Pcm p = pcm;
        if (p != null) p.syncTo(time);
    }

    /** The per-frame dts of a step command: "dts" wins over "dt", which wins over 1/fps. */
    public static double[] stepDts(Command c) {
        int frames = (int) Math.max(1, c.longValue("frames", 1));
        double dt = c.doubleValue("dt", 0);
        if (dt <= 0) dt = 1.0 / Math.max(1, hello != null ? hello.fps : 60);
        List<Object> dts = c.list("dts");
        double[] o = new double[frames];
        for (int i = 0; i < frames; i++) o[i] = dts != null && i < dts.size() ? Json.toDouble(dts.get(i), dt) : dt;
        return o;
    }

    /** {"frame", "time"}: the reply of step, the start of snapshot. */
    public static Map<String, Object> clock() {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("frame", frame);
        o.put("time", time);
        return o;
    }

    // ================================================================== logs

    /** A log line for the CLI ("info" | "warn" | "error"). Errors fail tests. No-op when not connected. */
    public static void log(String level, String message) {
        if (!connected) return;
        Map<String, Object> l = new LinkedHashMap<>();
        l.put("frame", frame);
        l.put("level", level == null ? "info" : level);
        l.put("message", message == null ? "" : message);
        synchronized (LOGS) { LOGS.add(l); }
    }

    public static void info(String message) { log("info", message); }
    public static void warn(String message) { log("warn", message); }
    public static void error(String message) { log("error", message); }

    private static List<Map<String, Object>> drainLogs() {
        synchronized (LOGS) {
            List<Map<String, Object>> o = new ArrayList<>(LOGS);
            LOGS.clear();
            return o;
        }
    }

    // ================================================================== recording (protocol section 5)

    public static synchronized boolean recording() { return rec != null; }

    /** Starts recording to WITNESS_RECORD if it is set (start() does this). Returns true if recording. */
    public static synchronized boolean startRecording(Hello h) {
        if (rec != null) return true;
        String path = env("WITNESS_RECORD");
        if (path == null || path.isEmpty() || active()) return false;
        try {
            File f = new File(path).getAbsoluteFile();
            if (f.getParentFile() != null) f.getParentFile().mkdirs();
            rec = new OutputStreamWriter(new java.io.FileOutputStream(f), StandardCharsets.UTF_8);
        } catch (IOException e) {
            System.err.println("[witness] can't record to '" + path + "': " + e.getMessage());
            return false;
        }
        if (h == null) h = new Hello();
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        Map<String, Object> head = new LinkedHashMap<>();
        head.put("replay", 1);
        head.put("name", h.name);
        head.put("seed", seed());
        head.put("fps", h.fps);
        head.put("started", iso.format(new Date()));
        recFrame = 0;
        writeRec(Json.write(head), true);
        Runtime.getRuntime().addShutdownHook(new Thread(Witness::stopRecording, "witness-recorder-flush"));
        return true;
    }

    /** Normal play: append one replay line for the frame just simulated. No-op unless recording. */
    public static synchronized void recordFrame(double dt, List<Event> events) {
        if (rec == null) return;
        StringBuilder sb = new StringBuilder(48).append("{\"f\":").append(recFrame).append(",\"dt\":");
        Json.writeValue(sb, dt, 0);
        if (events != null && !events.isEmpty()) {
            List<Object> list = new ArrayList<>(events.size());
            for (Event e : events) list.add(e.toJson(false));
            sb.append(",\"in\":");
            Json.writeValue(sb, list, 0);
        }
        boolean flush = recMark != null || recFrame % 60 == 0;
        if (recMark != null) { sb.append(",\"mark\":"); Json.writeString(sb, recMark); }
        writeRec(sb.append('}').toString(), flush);
        recMark = null;
        recFrame++;
    }

    /** Flags the current frame in the replay (the game calls this on F8). */
    public static synchronized void mark(String label) { if (rec != null) recMark = label == null ? "mark" : label; }

    public static synchronized void stopRecording() {
        if (rec == null) return;
        try { rec.close(); } catch (IOException ignored) { /* exiting */ }
        rec = null;
    }

    private static void writeRec(String line, boolean flush) {
        try {
            rec.write(line);
            rec.write('\n');
            if (flush) rec.flush();
        } catch (IOException e) {
            System.err.println("[witness] recording stopped: " + e.getMessage());
            rec = null;
        }
    }

    // ================================================================== helpers

    /** Base64 of interleaved floats as little-endian f32 (the protocol's audio format). */
    public static String base64F32(float[] samples) {
        ByteBuffer b = ByteBuffer.allocate(samples.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        b.asFloatBuffer().put(samples);
        return Base64.getEncoder().encodeToString(b.array());
    }

    public static String base64(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }

    static void sendLine(String json) {
        OutputStream o = out;
        if (o == null) return;
        byte[] bytes = (json + "\n").getBytes(StandardCharsets.UTF_8);
        synchronized (WRITE_GATE) {
            try {
                o.write(bytes);
                o.flush();
            } catch (IOException e) {
                markDisconnected();
            }
        }
    }

    private static Object filterPaths(Object state, List<Object> paths) {
        if (paths == null || paths.isEmpty() || !(state instanceof Map)) return state;
        Map<?, ?> d = (Map<?, ?>) state;
        Map<String, Object> o = new LinkedHashMap<>();
        for (Object p : paths) {
            String key = String.valueOf(p);
            if (key.startsWith("state.")) key = key.substring(6);
            int dot = key.indexOf('.'), br = key.indexOf('[');
            int cut = dot < 0 ? br : br < 0 ? dot : Math.min(dot, br);
            if (cut >= 0) key = key.substring(0, cut);
            if (d.containsKey(key)) o.put(key, d.get(key));
        }
        return o;
    }

    private static Map<String, Object> imageJson(Image img) {
        Map<String, Object> o = new LinkedHashMap<>();
        if (img.width > 0) o.put("width", img.width);
        if (img.height > 0) o.put("height", img.height);
        if (img.path != null) o.put("path", img.path);
        else if (img.png != null) { o.put("format", "png"); o.put("data", base64(img.png)); }
        else { o.put("format", "rgba8"); o.put("data", base64(img.rgba.length == img.width * img.height * 4 ? img.rgba : Arrays.copyOf(img.rgba, img.width * img.height * 4))); }
        return o;
    }

    private static String helloJson(Hello h, Handlers hs) {
        List<String> caps = h.capabilities;
        if (caps == null) {
            caps = new ArrayList<>(Arrays.asList("reset", "step", "input", "snapshot"));
            if (hs != null) {
                if (hs.screenshot != null) caps.add("screenshot");
                if (hs.audio != null || pcm != null) caps.add("audio");
                if (hs.call != null) caps.add("call");
                if (hs.eval != null) caps.add("eval");
                if (hs.perf != null) caps.add("perf");
            }
            caps.add("logs");
        }
        List<Object> calls = new ArrayList<>();
        for (Call c : h.calls) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("name", c.name);
            if (c.args != null) d.put("args", c.args);
            if (c.help != null) d.put("help", c.help);
            calls.add(d);
        }
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("protocol", PROTOCOL);
        o.put("name", h.name);
        o.put("engine", h.engine);
        o.put("language", h.language);
        o.put("fps", h.fps);
        if (h.width > 0 && h.height > 0) o.put("size", new int[] { h.width, h.height });
        o.put("capabilities", caps);
        o.put("calls", calls);
        if (h.keys != null) o.put("keys", h.keys);
        return Json.write(Collections.singletonMap("hello", o));
    }

    private static void readLoop(Socket s) {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        try {
            InputStream in = s.getInputStream();
            for (int n; (n = in.read(chunk)) > 0; ) {
                for (int i = 0; i < n; i++) {
                    if (chunk[i] != '\n') { line.write(chunk[i]); continue; }
                    String text = new String(line.toByteArray(), StandardCharsets.UTF_8).trim();
                    line.reset();
                    if (!text.isEmpty()) enqueue(text);
                }
            }
        } catch (IOException e) {
            // the socket closed: the session is over
        }
        markDisconnected();
    }

    @SuppressWarnings("unchecked")
    private static void enqueue(String text) {
        if (text.startsWith("@w")) text = text.substring(2);
        Object parsed;
        try { parsed = Json.parse(text); } catch (IllegalArgumentException e) { return; }
        if (!(parsed instanceof Map)) return;
        Map<String, Object> m = (Map<String, Object>) parsed;
        Command c = new Command(Json.toLong(m.get("id"), 0), Json.str(m.get("cmd"), ""), m);
        synchronized (GATE) {
            INBOX.add(c);
            GATE.notifyAll();
        }
    }

    private static void markDisconnected() {
        connected = false;
        synchronized (GATE) { GATE.notifyAll(); }
    }

    private static synchronized void disconnect() {
        Socket s = socket;
        socket = null;
        out = null;
        markDisconnected();
        if (s != null) { try { s.close(); } catch (IOException ignored) { /* already gone */ } }
    }

    private static String env(String name) {
        try { return System.getenv(name); } catch (SecurityException e) { return null; }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    // ================================================================== keys

    /**
     * Maps engine key names to Witness names ("right", "space", "1", "shift", "f8") and back.
     * Works by name with LibGDX (Input.Keys.toString / valueOf), AWT (KeyEvent.getKeyText is locale
     * dependent, so prefer explicit VK_ maps), LWJGL/GLFW names, jMonkeyEngine KeyInput names.
     */
    public static final class Keys {
        private static final Map<String, String> TO_WITNESS = new HashMap<>();
        private static final Map<String, String[]> FROM_WITNESS = new HashMap<>();

        static {
            String[][] to = {
                { "leftarrow", "left" }, { "rightarrow", "right" }, { "uparrow", "up" }, { "downarrow", "down" },
                { "dpadleft", "left" }, { "dpadright", "right" }, { "dpadup", "up" }, { "dpaddown", "down" },
                { "return", "enter" }, { "numpadenter", "enter" }, { "kpenter", "enter" }, { "esc", "escape" },
                { "spacebar", "space" }, { "back", "backspace" }, { "del", "backspace" }, { "delete", "backspace" },
                { "lshift", "shift" }, { "rshift", "shift" }, { "leftshift", "shift" }, { "rightshift", "shift" }, { "shiftleft", "shift" }, { "shiftright", "shift" },
                { "lctrl", "ctrl" }, { "rctrl", "ctrl" }, { "leftcontrol", "ctrl" }, { "rightcontrol", "ctrl" }, { "control", "ctrl" },
                { "controlleft", "ctrl" }, { "controlright", "ctrl" }, { "lcontrol", "ctrl" }, { "rcontrol", "ctrl" },
                { "lalt", "alt" }, { "ralt", "alt" }, { "leftalt", "alt" }, { "rightalt", "alt" }, { "altleft", "alt" }, { "altright", "alt" }, { "lmenu", "alt" }, { "rmenu", "alt" },
            };
            for (String[] p : to) TO_WITNESS.put(p[0], p[1]);
            FROM_WITNESS.put("left", new String[] { "Left", "LEFT", "LeftArrow" });
            FROM_WITNESS.put("right", new String[] { "Right", "RIGHT", "RightArrow" });
            FROM_WITNESS.put("up", new String[] { "Up", "UP", "UpArrow" });
            FROM_WITNESS.put("down", new String[] { "Down", "DOWN", "DownArrow" });
            FROM_WITNESS.put("enter", new String[] { "Enter", "ENTER", "Return", "RETURN" });
            FROM_WITNESS.put("escape", new String[] { "Escape", "ESCAPE", "Esc" });
            FROM_WITNESS.put("space", new String[] { "Space", "SPACE" });
            FROM_WITNESS.put("backspace", new String[] { "Backspace", "BACKSPACE", "Delete", "BACK" });
            FROM_WITNESS.put("tab", new String[] { "Tab", "TAB" });
            FROM_WITNESS.put("shift", new String[] { "L-Shift", "LSHIFT", "LEFT_SHIFT", "Shift", "SHIFT_LEFT" });
            FROM_WITNESS.put("ctrl", new String[] { "L-Ctrl", "LCONTROL", "LEFT_CONTROL", "Ctrl", "CONTROL_LEFT" });
            FROM_WITNESS.put("alt", new String[] { "L-Alt", "LMENU", "LEFT_ALT", "Alt", "ALT_LEFT" });
        }

        private Keys() {}

        /** Engine key name (e.g. Input.Keys.toString(code), "LeftArrow", "L-Shift", "NUM_1") to the Witness name. */
        public static String normalize(String engineName) {
            if (engineName == null) return "";
            String k = engineName.replace("_", "").replace("-", "").replace(" ", "").toLowerCase(Locale.ROOT);
            String mapped = TO_WITNESS.get(k);
            if (mapped != null) return mapped;
            for (String prefix : new String[] { "alpha", "digit", "key", "num", "d" })
                if (k.length() == prefix.length() + 1 && k.startsWith(prefix) && Character.isDigit(k.charAt(prefix.length()))) return k.substring(prefix.length());
            return k;
        }

        /** Witness name to engine names to try, most likely first. */
        public static String[] candidates(String witnessName) {
            if (witnessName == null || witnessName.isEmpty()) return new String[0];
            String[] c = FROM_WITNESS.get(witnessName.toLowerCase(Locale.ROOT));
            if (c != null) return c;
            if (witnessName.length() == 1 && Character.isDigit(witnessName.charAt(0)))
                return new String[] { witnessName, "NUM_" + witnessName, "KEY_" + witnessName, "Digit" + witnessName };
            String upper = witnessName.toUpperCase(Locale.ROOT);
            return new String[] { upper, Character.toUpperCase(witnessName.charAt(0)) + witnessName.substring(1), "KEY_" + upper };
        }

        /**
         * Witness name to an engine key code via the engine's own lookup, e.g. for LibGDX:
         * {@code Witness.Keys.lookup("right", Input.Keys::valueOf)} (valueOf returns -1 when unknown).
         * Returns -1 when no candidate matches.
         */
        public static int lookup(String witnessName, Function<String, Integer> byName) {
            for (String n : candidates(witnessName)) {
                Integer code;
                try { code = byName.apply(n); } catch (RuntimeException e) { continue; }
                if (code != null && code >= 0) return code;
            }
            return -1;
        }
    }

    // ================================================================== JSON

    /** A strict JSON reader and writer. Objects become LinkedHashMap, arrays ArrayList, integers Long, other numbers Double. */
    public static final class Json {
        private Json() {}

        public static Object parse(String text) {
            int[] i = { 0 };
            Object v = value(text, i);
            ws(text, i);
            if (i[0] != text.length()) throw new IllegalArgumentException("unexpected trailing characters at " + i[0]);
            return v;
        }

        public static String write(Object v) {
            StringBuilder sb = new StringBuilder(256);
            writeValue(sb, v, 0);
            return sb.toString();
        }

        public static String str(Object v, String fallback) { return v == null ? fallback : String.valueOf(v); }

        public static double toDouble(Object v, double fallback) {
            if (v instanceof Number) return ((Number) v).doubleValue();
            if (v instanceof String) { try { return Double.parseDouble(((String) v).trim()); } catch (NumberFormatException e) { return fallback; } }
            return fallback;
        }

        public static long toLong(Object v, long fallback) {
            if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) return ((Number) v).longValue();
            double d = toDouble(v, Double.NaN);
            return Double.isNaN(d) ? fallback : Math.round(d);
        }

        // ------------------------------------------------------------ writer

        public static void writeValue(StringBuilder sb, Object v, int depth) {
            if (depth > 64) { sb.append("\"<too deep>\""); return; }
            if (v == null) { sb.append("null"); return; }
            if (v instanceof String || v instanceof Character) { writeString(sb, v.toString()); return; }
            if (v instanceof Boolean) { sb.append(v.toString()); return; }
            if (v instanceof Double || v instanceof Float) { writeDouble(sb, ((Number) v).doubleValue(), v instanceof Float); return; }
            if (v instanceof Number) { sb.append(v.toString()); return; }
            if (v instanceof Enum) { writeString(sb, ((Enum<?>) v).name()); return; }
            if (v instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> kv : ((Map<?, ?>) v).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    writeString(sb, String.valueOf(kv.getKey()));
                    sb.append(':');
                    writeValue(sb, kv.getValue(), depth + 1);
                }
                sb.append('}');
                return;
            }
            if (v instanceof Iterable) {
                sb.append('[');
                boolean first = true;
                for (Object item : (Iterable<?>) v) {
                    if (!first) sb.append(',');
                    first = false;
                    writeValue(sb, item, depth + 1);
                }
                sb.append(']');
                return;
            }
            if (v.getClass().isArray()) {
                sb.append('[');
                for (int i = 0, n = Array.getLength(v); i < n; i++) {
                    if (i > 0) sb.append(',');
                    writeValue(sb, Array.get(v, i), depth + 1);
                }
                sb.append(']');
                return;
            }
            writeObject(sb, v, depth);
        }

        public static void writeString(StringBuilder sb, String s) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    default:
                        if (c < 0x20 || c == (char) 0x2028 || c == (char) 0x2029) sb.append('\\').append('u').append(String.format(Locale.ROOT, "%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }

        // Whole numbers print without ".0" (as JavaScript does); floats print their shortest float form.
        private static void writeDouble(StringBuilder sb, double d, boolean isFloat) {
            if (Double.isNaN(d)) sb.append("\"NaN\"");
            else if (Double.isInfinite(d)) sb.append(d > 0 ? "\"Infinity\"" : "\"-Infinity\"");
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
            else sb.append(isFloat ? Float.toString((float) d) : Double.toString(d));
        }

        // Vectors (LibGDX Vector2/3, JOML, jME Vector3f) become [x, y(, z(, w))]; other objects become
        // {publicField: value} over their public instance fields (getters are not called).
        private static void writeObject(StringBuilder sb, Object v, int depth) {
            Class<?> t = v.getClass();
            String n = t.getSimpleName();
            if (n.startsWith("Vector") || n.startsWith("Vec") || n.equals("Point") || n.startsWith("Quaternion")) {
                List<Object> parts = new ArrayList<>(4);
                for (String axis : new String[] { "x", "y", "z", "w" }) {
                    Object c = member(v, t, axis);
                    if (c == null) break;
                    parts.add(c);
                }
                if (parts.size() >= 2) { writeValue(sb, parts, depth + 1); return; }
            }
            sb.append('{');
            boolean first = true;
            for (Field f : t.getFields()) {
                if (Modifier.isStatic(f.getModifiers())) continue;
                if (!first) sb.append(',');
                first = false;
                writeString(sb, f.getName());
                sb.append(':');
                try { writeValue(sb, f.get(v), depth + 1); } catch (IllegalAccessException e) { sb.append("null"); }
            }
            sb.append('}');
        }

        private static Object member(Object v, Class<?> t, String axis) {
            try { Field f = t.getField(axis); if (!Modifier.isStatic(f.getModifiers())) return f.get(v); } catch (ReflectiveOperationException ignored) { /* try a getter */ }
            try { Method m = t.getMethod(axis); if (m.getParameterCount() == 0) return m.invoke(v); } catch (ReflectiveOperationException ignored) { /* none */ }
            try { Method m = t.getMethod("get" + Character.toUpperCase(axis.charAt(0))); return m.invoke(v); } catch (ReflectiveOperationException ignored) { /* none */ }
            return null;
        }

        // ------------------------------------------------------------ reader

        private static void ws(String s, int[] i) {
            while (i[0] < s.length()) {
                char c = s.charAt(i[0]);
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
                i[0]++;
            }
        }

        private static Object value(String s, int[] i) {
            ws(s, i);
            if (i[0] >= s.length()) throw new IllegalArgumentException("unexpected end of JSON");
            char c = s.charAt(i[0]);
            switch (c) {
                case '{': return object(s, i);
                case '[': return array(s, i);
                case '"': return string(s, i);
                case 't': return literal(s, i, "true", Boolean.TRUE);
                case 'f': return literal(s, i, "false", Boolean.FALSE);
                case 'n': return literal(s, i, "null", null);
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return number(s, i);
                    throw new IllegalArgumentException("unexpected '" + c + "' at " + i[0]);
            }
        }

        private static Object literal(String s, int[] i, String word, Object v) {
            if (!s.startsWith(word, i[0])) throw new IllegalArgumentException("bad literal at " + i[0]);
            i[0] += word.length();
            return v;
        }

        private static Map<String, Object> object(String s, int[] i) {
            Map<String, Object> o = new LinkedHashMap<>();
            i[0]++;
            ws(s, i);
            if (i[0] < s.length() && s.charAt(i[0]) == '}') { i[0]++; return o; }
            for (;;) {
                ws(s, i);
                if (i[0] >= s.length() || s.charAt(i[0]) != '"') throw new IllegalArgumentException("expected a key at " + i[0]);
                String key = string(s, i);
                ws(s, i);
                if (i[0] >= s.length() || s.charAt(i[0]) != ':') throw new IllegalArgumentException("expected ':' at " + i[0]);
                i[0]++;
                o.put(key, value(s, i));
                ws(s, i);
                if (i[0] >= s.length()) throw new IllegalArgumentException("unterminated object");
                char c = s.charAt(i[0]++);
                if (c == ',') continue;
                if (c == '}') return o;
                throw new IllegalArgumentException("expected ',' or '}' at " + (i[0] - 1));
            }
        }

        private static List<Object> array(String s, int[] i) {
            List<Object> a = new ArrayList<>();
            i[0]++;
            ws(s, i);
            if (i[0] < s.length() && s.charAt(i[0]) == ']') { i[0]++; return a; }
            for (;;) {
                a.add(value(s, i));
                ws(s, i);
                if (i[0] >= s.length()) throw new IllegalArgumentException("unterminated array");
                char c = s.charAt(i[0]++);
                if (c == ',') continue;
                if (c == ']') return a;
                throw new IllegalArgumentException("expected ',' or ']' at " + (i[0] - 1));
            }
        }

        private static String string(String s, int[] i) {
            i[0]++;
            StringBuilder sb = new StringBuilder();
            while (i[0] < s.length()) {
                char c = s.charAt(i[0]++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                if (i[0] >= s.length()) break;
                char e = s.charAt(i[0]++);
                switch (e) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (i[0] + 4 > s.length()) throw new IllegalArgumentException("bad unicode escape");
                        try { sb.append((char) Integer.parseInt(s.substring(i[0], i[0] + 4), 16)); }
                        catch (NumberFormatException ex) { throw new IllegalArgumentException("bad unicode escape at " + i[0]); }
                        i[0] += 4;
                        break;
                    default: throw new IllegalArgumentException("bad escape at " + (i[0] - 1));
                }
            }
            throw new IllegalArgumentException("unterminated string");
        }

        private static Object number(String s, int[] i) {
            int start = i[0];
            boolean integral = true;
            if (s.charAt(i[0]) == '-') i[0]++;
            while (i[0] < s.length()) {
                char c = s.charAt(i[0]);
                if (c >= '0' && c <= '9') { i[0]++; continue; }
                if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { integral = false; i[0]++; continue; }
                break;
            }
            String num = s.substring(start, i[0]);
            try {
                if (integral) return Long.parseLong(num);
            } catch (NumberFormatException ignored) { /* too big: fall through to double */ }
            try { return Double.parseDouble(num); }
            catch (NumberFormatException e) { throw new IllegalArgumentException("bad number '" + num + "' at " + start); }
        }
    }
}
