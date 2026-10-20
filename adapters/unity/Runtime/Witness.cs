// Witness.cs: the Witness adapter for C# (protocol v1, docs/PROTOCOL.md).
//
// One file, no dependencies, netstandard2.0 / C# 7.3, so the same file drops into .NET 6/8,
// Unity, Godot 4 (.NET), MonoGame, FNA and Stride. It contains a TCP client, a tiny JSON
// reader/writer (Unity has no System.Text.Json), base64 helpers, a PCM capture buffer, a replay
// recorder (WITNESS_RECORD) and key-name mapping.
//
// Zero cost when inactive: nothing connects, no thread starts and nothing allocates unless
// WITNESS_ADDR is set (or the game was started with --witness) or WITNESS_RECORD is set.
//
// Minimal use (the game owns nothing in witness mode; Witness.Run owns the loop until quit):
//
//   var hello = new WitnessHello { Name = "My Game", Engine = "MonoGame", Fps = 60, Width = 320, Height = 180 };
//   var handlers = new WitnessHandlers {
//       Reset = (seed, scene, args) => game.Reset(seed),
//       Input = e => game.Apply(e),                // a WitnessEvent, at the start of its frame
//       Step = dt => game.Update(dt),               // exactly one fixed frame
//       Snapshot = () => game.State(),              // dictionaries / lists / numbers / strings
//   };
//   if (Witness.Start(hello, handlers)) { Witness.Run(handlers); return; }
//   // ...otherwise the normal real-time loop (call Witness.RecordFrame(dt, events) once per frame)
//
// Engines that own the frame loop (Unity, Godot) use the lower-level pieces instead:
// Witness.TryNext(out cmd), Witness.Handle(cmd, handlers), cmd.Reply(...), BeginFrame/EndFrame.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;

namespace WitnessKit
{
    /// <summary>A custom command advertised in the hello (`witness call name args`).</summary>
    public sealed class WitnessCall
    {
        public string Name;
        public string Args;
        public string Help;

        public WitnessCall(string name, string args = null, string help = null)
        {
            Name = name;
            Args = args;
            Help = help;
        }
    }

    /// <summary>The handshake sent on connect (protocol section 2).</summary>
    public sealed class WitnessHello
    {
        public string Name = "game";
        public string Engine = "custom";
        public string Language = "c#";
        public int Fps = 60;
        public int Width;
        public int Height;
        public List<WitnessCall> Calls = new List<WitnessCall>();
        /// <summary>Optional: the Witness key names the game actually uses.</summary>
        public List<string> Keys;
        /// <summary>Leave null to derive it from the handlers that are set.</summary>
        public List<string> Capabilities;
        /// <summary>
        /// True when the game handles "touch" events itself: finger 0 is then NOT also delivered as mouse
        /// events (the default mouse fallback), and the hello says "touch": true.
        /// </summary>
        public bool Touch;
    }

    /// <summary>The phase of a "touch" event (protocol section 4).</summary>
    public enum WitnessTouchPhase
    {
        Down,
        Move,
        Up,
        /// <summary>The system ended the touch (SDL's FINGER_CANCELED, Unity's TouchPhase.Canceled: the OS took
        /// the gesture, focus was lost). Ends the finger like Up, but it is not a completed tap; games that don't
        /// care may treat it as Up. Appended last so the values above keep their numbers.</summary>
        Cancel,
    }

    /// <summary>One input event (protocol section 4). Unused fields keep their defaults.</summary>
    public sealed class WitnessEvent
    {
        public int Frame;
        /// <summary>key | mouse | wheel | text | action | pad | axis | touch (or anything the game understands).</summary>
        public string Type = "";
        public string Key;
        /// <summary>null for events without a down/up meaning (mouse moves, wheel, text, axis, touch moves).
        /// Touch: true on down, false on up or cancel.</summary>
        public bool? Down;
        /// <summary>Mouse and touch: logical pixels, top-left origin.</summary>
        public double X;
        public double Y;
        /// <summary>Mouse: 0 left, 1 middle, 2 right. Pads use <see cref="PadButton"/>.</summary>
        public int Button;
        public string PadButton;
        public double Dx;
        public double Dy;
        public string Text;
        public string Action;
        public string Axis;
        public double Value;
        /// <summary>Touch: the finger, 0 = the first finger down (the same from down to up).</summary>
        public int Id;
        /// <summary>Touch: down, move, up or cancel (a missing or unknown phase reads as Move).</summary>
        public WitnessTouchPhase Phase = WitnessTouchPhase.Move;
        /// <summary>Touch: 0..1, 1 when not given.</summary>
        public double Pressure = 1;
        /// <summary>
        /// Mouse: synthesized from finger 0 by the mouse fallback (like SDL's SDL_TOUCH_MOUSEID). Skip it if the
        /// game also handles the touch event. Never recorded.
        /// </summary>
        public bool FromTouch;
        /// <summary>The event exactly as received, including fields this class doesn't model.</summary>
        public Dictionary<string, object> Raw;

        public bool IsDown { get { return Down == true; } }
        public bool IsUp { get { return Down == false; } }

        /// <summary>A key event, e.g. for Witness.RecordFrame in normal play.</summary>
        public static WitnessEvent KeyEvent(string key, bool down) { return new WitnessEvent { Type = "key", Key = key, Down = down }; }

        /// <summary>A touch event in logical pixels (id 0 = first finger down), e.g. for Witness.RecordFrame in normal play.</summary>
        public static WitnessEvent TouchEvent(int id, double x, double y, WitnessTouchPhase phase, double pressure = 1)
        {
            return new WitnessEvent
            {
                Type = "touch", Id = id, X = x, Y = y, Phase = phase, Pressure = pressure,
                Down = phase == WitnessTouchPhase.Down ? true : phase == WitnessTouchPhase.Move ? (bool?)null : false,
            };
        }

        public static WitnessEvent FromJson(Dictionary<string, object> o)
        {
            var e = new WitnessEvent { Raw = o };
            e.Frame = (int)WitnessJson.Long(WitnessJson.Get(o, "frame"), 0);
            e.Type = WitnessJson.Str(WitnessJson.Get(o, "type")) ?? "";
            e.Key = WitnessJson.Str(WitnessJson.Get(o, "key"));
            object down = WitnessJson.Get(o, "down");
            if (down is bool) e.Down = (bool)down;
            e.X = WitnessJson.Double(WitnessJson.Get(o, "x"), 0);
            e.Y = WitnessJson.Double(WitnessJson.Get(o, "y"), 0);
            object button = WitnessJson.Get(o, "button");
            if (button is string) e.PadButton = (string)button;
            else e.Button = (int)WitnessJson.Long(button, 0);
            e.Dx = WitnessJson.Double(WitnessJson.Get(o, "dx"), 0);
            e.Dy = WitnessJson.Double(WitnessJson.Get(o, "dy"), 0);
            e.Text = WitnessJson.Str(WitnessJson.Get(o, "text"));
            e.Action = WitnessJson.Str(WitnessJson.Get(o, "action"));
            e.Axis = WitnessJson.Str(WitnessJson.Get(o, "axis"));
            e.Value = WitnessJson.Double(WitnessJson.Get(o, "value"), 0);
            if (e.Type == "touch")
            {
                e.Id = (int)WitnessJson.Long(WitnessJson.Get(o, "id"), 0);
                string phase = WitnessJson.Str(WitnessJson.Get(o, "phase"));
                e.Phase = phase == "down" ? WitnessTouchPhase.Down : phase == "up" ? WitnessTouchPhase.Up
                        : phase == "cancel" ? WitnessTouchPhase.Cancel : WitnessTouchPhase.Move;
                e.Pressure = WitnessJson.Double(WitnessJson.Get(o, "pressure"), 1);
                e.Down = e.Phase == WitnessTouchPhase.Down ? true : e.Phase == WitnessTouchPhase.Move ? (bool?)null : false;
            }
            return e;
        }

        /// <summary>The protocol shape. Replays omit the frame (it is the line's "f").</summary>
        public Dictionary<string, object> ToJson(bool includeFrame = true)
        {
            var o = new Dictionary<string, object>();
            if (includeFrame) o["frame"] = Frame;
            o["type"] = Type;
            switch (Type)
            {
                case "key": o["key"] = Key; break;
                case "mouse": o["x"] = X; o["y"] = Y; if (Down.HasValue) o["button"] = Button; break;
                case "wheel": if (Dx != 0) o["dx"] = Dx; o["dy"] = Dy; break;
                case "text": o["text"] = Text; break;
                case "action": o["action"] = Action; break;
                case "pad": o["button"] = PadButton; break;
                case "axis": o["axis"] = Axis; o["value"] = Value; break;
                case "touch":
                    o["id"] = Id; o["x"] = X; o["y"] = Y;
                    o["phase"] = Phase == WitnessTouchPhase.Down ? "down" : Phase == WitnessTouchPhase.Up ? "up"
                        : Phase == WitnessTouchPhase.Cancel ? "cancel" : "move";
                    if (Pressure > 0 && Pressure != 1) o["pressure"] = Pressure;
                    return o;   // a touch's down/up is its phase
                default:
                    if (Raw != null) foreach (var kv in Raw) if (kv.Key != "frame") o[kv.Key] = kv.Value;
                    break;
            }
            if (Down.HasValue) o["down"] = Down.Value;
            return o;
        }

        public override string ToString() { return WitnessJson.Write(ToJson()); }
    }

    /// <summary>A screenshot: raw RGBA (top-to-bottom rows), an encoded PNG, or a file path.</summary>
    public sealed class WitnessImage
    {
        public int Width;
        public int Height;
        public byte[] Rgba;
        public byte[] Png;
        public string Path;

        public static WitnessImage FromRgba(int width, int height, byte[] rgba, bool bottomUp = false)
        {
            if (rgba == null || rgba.Length < width * height * 4) throw new ArgumentException("rgba must hold width*height*4 bytes");
            return new WitnessImage { Width = width, Height = height, Rgba = bottomUp ? FlipRows(rgba, width, height) : rgba };
        }

        public static WitnessImage FromPng(byte[] png, int width = 0, int height = 0) { return new WitnessImage { Png = png, Width = width, Height = height }; }
        public static WitnessImage FromFile(string path, int width = 0, int height = 0) { return new WitnessImage { Path = path, Width = width, Height = height }; }

        /// <summary>GPU readbacks (OpenGL, Unity's Texture2D) are bottom-up; the protocol wants top-down.</summary>
        public static byte[] FlipRows(byte[] rgba, int width, int height)
        {
            int stride = width * 4;
            var o = new byte[stride * height];
            for (int y = 0; y < height; y++) Buffer.BlockCopy(rgba, y * stride, o, (height - 1 - y) * stride, stride);
            return o;
        }

        /// <summary>Nearest-neighbour resize of an RGBA image (used for the screenshot `scale` argument).</summary>
        public WitnessImage Scaled(double scale)
        {
            if (Rgba == null || scale <= 0 || Math.Abs(scale - 1) < 1e-9) return this;
            int w = Math.Max(1, (int)Math.Round(Width * scale)), h = Math.Max(1, (int)Math.Round(Height * scale));
            var o = new byte[w * h * 4];
            for (int y = 0; y < h; y++)
            {
                int sy = Math.Min(Height - 1, (int)(y / scale));
                for (int x = 0; x < w; x++)
                {
                    int sx = Math.Min(Width - 1, (int)(x / scale));
                    Buffer.BlockCopy(Rgba, (sy * Width + sx) * 4, o, (y * w + x) * 4, 4);
                }
            }
            return new WitnessImage { Width = w, Height = h, Rgba = o };
        }
    }

    /// <summary>Interleaved float PCM in [-1, 1].</summary>
    public sealed class WitnessAudio
    {
        public int SampleRate;
        public int Channels;
        public float[] Samples;
    }

    /// <summary>
    /// Captures the game's audio in witness mode, synchronized with simulated time: after a frame
    /// ends at time t the buffer holds exactly round(t * SampleRate) frames.
    /// Play() mixes a sound starting "now" (games that synthesize or own their mixer);
    /// Write() appends a continuous stream (engine mixers: Unity AudioRenderer, OnAudioFilterRead).
    /// Thread-safe, so an audio thread may Write() while the game thread steps.
    /// </summary>
    public sealed class WitnessPcm
    {
        public readonly int SampleRate;
        public readonly int Channels;
        private readonly List<float> _buf = new List<float>();
        private long _origin;   // absolute frame index of _buf[0]
        private long _cursor;   // absolute frame index of "now" (simulated time)

        public WitnessPcm(int sampleRate = 44100, int channels = 1)
        {
            if (sampleRate <= 0 || channels <= 0) throw new ArgumentException("sampleRate and channels must be positive");
            SampleRate = sampleRate;
            Channels = channels;
        }

        /// <summary>Mixes interleaved samples into the buffer starting at the current simulated time.</summary>
        public void Play(float[] samples, float gain = 1f)
        {
            if (samples == null) return;
            lock (_buf)
            {
                int start = (int)(_cursor - _origin) * Channels;
                if (start < 0) start = 0;
                int need = start + samples.Length;
                while (_buf.Count < need) _buf.Add(0f);
                for (int i = 0; i < samples.Length; i++) _buf[start + i] += samples[i] * gain;
            }
        }

        /// <summary>Appends interleaved samples after everything already buffered.</summary>
        public void Write(float[] samples, int offset = 0, int count = -1)
        {
            if (samples == null) return;
            if (count < 0) count = samples.Length - offset;
            lock (_buf) for (int i = 0; i < count; i++) _buf.Add(samples[offset + i]);
        }

        /// <summary>Advances "now" to simulated time t, padding with silence. Witness.EndFrame calls this.</summary>
        public void SyncTo(double time)
        {
            lock (_buf)
            {
                _cursor = (long)Math.Round(time * SampleRate);
                long need = (_cursor - _origin) * Channels;
                while (_buf.Count < need) _buf.Add(0f);
            }
        }

        /// <summary>Takes everything up to "now". Sound that rings past it stays for the next call.</summary>
        public WitnessAudio Drain()
        {
            lock (_buf)
            {
                int n = (int)Math.Max(0, Math.Min(_buf.Count, (_cursor - _origin) * Channels));
                var o = new float[n];
                _buf.CopyTo(0, o, 0, n);
                _buf.RemoveRange(0, n);
                _origin += n / Channels;
                return new WitnessAudio { SampleRate = SampleRate, Channels = Channels, Samples = o };
            }
        }

        public void Clear()
        {
            lock (_buf)
            {
                _buf.Clear();
                _origin = 0;
                _cursor = 0;
            }
        }
    }

    /// <summary>Callbacks for the commands the game supports. A null handler means "not supported".</summary>
    public sealed class WitnessHandlers
    {
        /// <summary>(seed, scene or null, params or null). Must restore a deterministic initial state.</summary>
        public Action<int, string, Dictionary<string, object>> Reset;
        /// <summary>Called for each queued event at the start of its frame, before Step.</summary>
        public Action<WitnessEvent> Input;
        /// <summary>Advance exactly one frame by dt seconds.</summary>
        public Action<double> Step;
        /// <summary>A JSON-able tree: IDictionary, IEnumerable, numbers, strings, bools, null, vectors.</summary>
        public Func<object> Snapshot;
        /// <summary>(scale) → the current frame. Witness rescales RGBA images itself.</summary>
        public Func<double, WitnessImage> Screenshot;
        /// <summary>Optional: by default Witness drains <see cref="Witness.Pcm"/>.</summary>
        public Func<WitnessAudio> Audio;
        /// <summary>(name, args) → result. Throw to report an error (unknown call, bad args).</summary>
        public Func<string, List<object>, object> Call;
        public Func<string, object> Eval;
        /// <summary>A dictionary merged into the reply: frame_ms, update_ms, render_ms, counts.</summary>
        public Func<object> Perf;
        /// <summary>Called after the quit reply is sent.</summary>
        public Action Quit;
    }

    /// <summary>One command from the CLI. Answer it exactly once with Reply or Fail.</summary>
    public sealed class WitnessCommand
    {
        public readonly long Id;
        public readonly string Name;
        public readonly Dictionary<string, object> Args;
        public bool Answered { get; private set; }

        internal WitnessCommand(long id, string name, Dictionary<string, object> args)
        {
            Id = id;
            Name = name;
            Args = args;
        }

        public object Get(string key) { return WitnessJson.Get(Args, key); }
        public string String(string key, string fallback = null) { return WitnessJson.Str(Get(key)) ?? fallback; }
        public long Long(string key, long fallback) { return WitnessJson.Long(Get(key), fallback); }
        public double Double(string key, double fallback) { return WitnessJson.Double(Get(key), fallback); }
        public List<object> List(string key) { return Get(key) as List<object>; }
        public Dictionary<string, object> Object(string key) { return Get(key) as Dictionary<string, object>; }

        /// <summary>Sends {"id", "ok": true, ...fields}. Fields may be null for an empty result.</summary>
        public void Reply(IDictionary<string, object> fields = null)
        {
            if (Answered) return;
            Answered = true;
            var sb = new StringBuilder(64);
            sb.Append("{\"id\":").Append(Id.ToString(CultureInfo.InvariantCulture)).Append(",\"ok\":true");
            if (fields != null)
            {
                foreach (var kv in fields)
                {
                    if (kv.Key == "id" || kv.Key == "ok") continue;
                    sb.Append(',');
                    WitnessJson.WriteString(sb, kv.Key);
                    sb.Append(':');
                    WitnessJson.WriteValue(sb, kv.Value, 0);
                }
            }
            sb.Append('}');
            Witness.SendLine(sb.ToString());
        }

        public void Fail(string error)
        {
            if (Answered) return;
            Answered = true;
            var sb = new StringBuilder(64);
            sb.Append("{\"id\":").Append(Id.ToString(CultureInfo.InvariantCulture)).Append(",\"ok\":false,\"error\":");
            WitnessJson.WriteString(sb, error ?? "error");
            sb.Append('}');
            Witness.SendLine(sb.ToString());
        }
    }

    /// <summary>The Witness adapter. All members are safe to call when Witness is inactive (they no-op).</summary>
    public static class Witness
    {
        public const int Protocol = 1;
        public const string DefaultAddress = "127.0.0.1:7357";

        private static readonly object Gate = new object();
        private static readonly object WriteGate = new object();
        private static readonly Queue<WitnessCommand> Inbox = new Queue<WitnessCommand>();
        private static readonly List<WitnessEvent> Pending = new List<WitnessEvent>();
        private static readonly List<Dictionary<string, object>> Logs = new List<Dictionary<string, object>>();
        private static List<WitnessEvent> _frameEvents = new List<WitnessEvent>();
        private static TcpClient _client;
        private static Stream _stream;
        private static volatile bool _connected;
        private static bool _quitting;
        private static bool? _active;
        private static int _seed = 1;
        private static bool _seedChosen;
        private static WitnessHello _hello;
        private static WitnessHandlers _handlers;
        private static TextWriter _rec;
        private static string _recPath;
        private static bool _endStateWritten;   // stale once another frame is recorded (a vetoed quit: play went on)
        private static int _recFrame;
        private static double _recTime;
        private static string _recMark;
        private static readonly List<WitnessEvent> RecQueue = new List<WitnessEvent>();

        /// <summary>The simulated frame number (frames stepped since the last reset).</summary>
        public static int Frame { get; private set; }

        /// <summary>The simulated time in seconds since the last reset.</summary>
        public static double Time { get; private set; }

        /// <summary>Set this in witness mode to capture audio; the game then calls Pcm.Play / Pcm.Write.</summary>
        public static WitnessPcm Pcm;

        /// <summary>True when the game should run in witness mode (WITNESS_ADDR set, or --witness passed).</summary>
        public static bool Active
        {
            get
            {
                if (_active == null)
                {
                    bool on = !string.IsNullOrEmpty(Env("WITNESS_ADDR"));
                    if (!on)
                    {
                        try { foreach (var a in Environment.GetCommandLineArgs()) if (a == "--witness") { on = true; break; } }
                        catch (Exception) { /* some platforms have no command line */ }
                    }
                    _active = on;
                }
                return _active.Value;
            }
        }

        /// <summary>True while connected to the CLI.</summary>
        public static bool Connected { get { return _connected; } }

        /// <summary>The host:port to connect to.</summary>
        public static string Address
        {
            get
            {
                string a = Env("WITNESS_ADDR");
                return string.IsNullOrEmpty(a) ? DefaultAddress : a;
            }
        }

        /// <summary>True when a human session is being recorded to WITNESS_RECORD.</summary>
        public static bool Recording { get { return _rec != null; } }

        /// <summary>
        /// The seed for every RNG: the reset seed in witness mode; otherwise WITNESS_SEED, or a seed
        /// picked once per run (and written to the replay header when recording).
        /// </summary>
        public static int Seed
        {
            get
            {
                if (!_seedChosen && !Active)
                {
                    _seedChosen = true;
                    int s;
                    string env = Env("WITNESS_SEED");
                    _seed = !string.IsNullOrEmpty(env) && int.TryParse(env, NumberStyles.Integer, CultureInfo.InvariantCulture, out s)
                        ? s : (int)(DateTime.UtcNow.Ticks % 1000000) + 1;
                }
                return _seed;
            }
        }

        /// <summary>The events being applied in the current frame (inside Step, or between BeginFrame and EndFrame).</summary>
        public static IList<WitnessEvent> FrameEvents { get { return _frameEvents; } }

        /// <summary>
        /// The one-call entry point. In witness mode: connects and returns true (then call Run, or poll).
        /// Otherwise starts recording if WITNESS_RECORD is set and returns false.
        /// </summary>
        public static bool Start(WitnessHello hello, WitnessHandlers handlers = null)
        {
            if (Active) return Connect(hello, handlers);
            StartRecording(hello);
            return false;
        }

        /// <summary>Connects to the CLI and sends the hello. Retries for ~3 s. Returns false on failure.</summary>
        public static bool Connect(WitnessHello hello, WitnessHandlers handlers = null)
        {
            if (_connected) return true;
            _hello = hello ?? new WitnessHello();
            _handlers = handlers;
            string addr = Address;
            int colon = addr.LastIndexOf(':');
            int port;
            if (colon <= 0 || !int.TryParse(addr.Substring(colon + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out port))
            {
                Console.Error.WriteLine("[witness] bad WITNESS_ADDR '" + addr + "' (expected host:port)");
                return false;
            }
            string host = addr.Substring(0, colon);
            Exception last = null;
            for (int attempt = 0; attempt < 30; attempt++)
            {
                try
                {
                    var c = new TcpClient();
                    c.NoDelay = true;
                    c.Connect(host, port);
                    _client = c;
                    _stream = c.GetStream();
                    break;
                }
                catch (Exception e)
                {
                    last = e;
                    Thread.Sleep(100);
                }
            }
            if (_client == null)
            {
                Console.Error.WriteLine("[witness] could not connect to " + addr + ": " + (last != null ? last.Message : "unknown error"));
                return false;
            }
            _connected = true;
            _quitting = false;
            SendLine(HelloJson(_hello, handlers));
            var reader = new Thread(ReadLoop) { IsBackground = true, Name = "witness-reader" };
            reader.Start();
            return true;
        }

        /// <summary>Owns the loop until the CLI quits or disconnects.</summary>
        public static void Run(WitnessHandlers handlers = null)
        {
            while (Poll(handlers)) { }
        }

        /// <summary>Waits for one command and handles it. Returns false once the session is over.</summary>
        public static bool Poll(WitnessHandlers handlers = null)
        {
            var cmd = Next();
            if (cmd == null) return false;
            Handle(cmd, handlers ?? _handlers ?? new WitnessHandlers());
            return !_quitting && _connected;
        }

        /// <summary>Blocks until a command arrives (or timeoutMs passes; -1 = forever). Null when disconnected.</summary>
        public static WitnessCommand Next(int timeoutMs = -1)
        {
            lock (Gate)
            {
                int waited = 0;
                while (Inbox.Count == 0)
                {
                    if (!_connected) return null;
                    if (timeoutMs >= 0 && waited >= timeoutMs) return null;
                    int slice = timeoutMs < 0 ? 250 : Math.Min(250, timeoutMs - waited);
                    Monitor.Wait(Gate, slice);
                    waited += slice;
                }
                return Inbox.Dequeue();
            }
        }

        /// <summary>Non-blocking: for engines that poll once per engine frame.</summary>
        public static bool TryNext(out WitnessCommand cmd)
        {
            lock (Gate)
            {
                cmd = Inbox.Count > 0 ? Inbox.Dequeue() : null;
                return cmd != null;
            }
        }

        /// <summary>Answers a command with the default behaviour, calling the handlers. Never throws.</summary>
        public static void Handle(WitnessCommand cmd, WitnessHandlers h)
        {
            try
            {
                switch (cmd.Name)
                {
                    case "reset":
                        int seed = (int)cmd.Long("seed", 1);
                        ResetClock(seed);
                        if (h.Reset != null) h.Reset(seed, cmd.String("scene"), cmd.Object("params"));
                        cmd.Reply();
                        break;
                    case "input":
                        QueueInput(cmd.List("events"));
                        cmd.Reply();
                        break;
                    case "step":
                        if (h.Step == null) { cmd.Fail("this game has no step handler"); break; }
                        StepFrames(cmd, h);
                        cmd.Reply(Clock());
                        break;
                    case "snapshot":
                        if (h.Snapshot == null) { cmd.Fail("this game has no snapshot handler"); break; }
                        var snap = Clock();
                        snap["state"] = FilterPaths(h.Snapshot(), cmd.List("paths"));
                        cmd.Reply(snap);
                        break;
                    case "screenshot":
                        if (h.Screenshot == null) { cmd.Fail("this game has no screenshot handler"); break; }
                        double scale = cmd.Double("scale", 1);
                        var img = h.Screenshot(scale);
                        if (img == null) { cmd.Fail("the screenshot handler returned nothing"); break; }
                        cmd.Reply(ImageJson(img.Scaled(scale)));
                        break;
                    case "audio":
                        WitnessAudio au = h.Audio != null ? h.Audio() : Pcm != null ? Pcm.Drain() : null;
                        if (au == null) { cmd.Fail("this game doesn't capture audio (set Witness.Pcm or an Audio handler)"); break; }
                        cmd.Reply(AudioJson(au));
                        break;
                    case "call":
                        if (h.Call == null) { cmd.Fail("this game has no custom calls"); break; }
                        var callArgs = cmd.List("args") ?? new List<object>();
                        cmd.Reply(new Dictionary<string, object> { { "result", h.Call(cmd.String("name", ""), callArgs) } });
                        break;
                    case "eval":
                        if (h.Eval == null) { cmd.Fail("eval is not supported by this game"); break; }
                        cmd.Reply(new Dictionary<string, object> { { "value", h.Eval(cmd.String("expr", "")) } });
                        break;
                    case "logs":
                        cmd.Reply(new Dictionary<string, object> { { "logs", DrainLogs() } });
                        break;
                    case "perf":
                        if (h.Perf == null) { cmd.Fail("perf is not supported by this game"); break; }
                        var perf = h.Perf() as IDictionary;
                        var fields = new Dictionary<string, object>();
                        if (perf != null) foreach (DictionaryEntry kv in perf) fields[Convert.ToString(kv.Key, CultureInfo.InvariantCulture)] = kv.Value;
                        cmd.Reply(fields);
                        break;
                    case "quit":
                        cmd.Reply();
                        _quitting = true;
                        Disconnect();
                        if (h.Quit != null) h.Quit();
                        break;
                    default:
                        cmd.Fail("unknown command '" + cmd.Name + "'");
                        break;
                }
            }
            catch (Exception e)
            {
                cmd.Fail(e.GetType().Name + ": " + e.Message);
            }
        }

        /// <summary>Resets the frame clock, input queue and audio capture. Handle("reset") calls this.</summary>
        public static void ResetClock(int seed)
        {
            _seed = seed;
            _seedChosen = true;
            Frame = 0;
            Time = 0;
            lock (Pending) Pending.Clear();
            _frameEvents = new List<WitnessEvent>();
            if (Pcm != null) Pcm.Clear();
        }

        /// <summary>
        /// Queues protocol events (the "events" array of an input command). Mouse fallback: unless the hello
        /// set Touch, each touch of finger 0 is followed by the matching mouse event (down: button 0 down at
        /// x,y; move: a move; up or cancel: button 0 up), flagged FromTouch. Other fingers never make mouse events.
        /// </summary>
        public static void QueueInput(List<object> events)
        {
            if (events == null) return;
            bool fallback = _hello == null || !_hello.Touch;
            lock (Pending)
            {
                foreach (var o in events)
                {
                    var d = o as Dictionary<string, object>;
                    if (d == null) continue;
                    var e = WitnessEvent.FromJson(d);
                    Pending.Add(e);
                    if (fallback && e.Type == "touch" && e.Id == 0)
                        Pending.Add(new WitnessEvent { Frame = e.Frame, Type = "mouse", X = e.X, Y = e.Y, Button = 0, Down = e.Down, FromTouch = true });
                }
            }
        }

        /// <summary>Starts a frame: removes and returns the queued events due now (frame ≤ Frame), in arrival order.</summary>
        public static List<WitnessEvent> BeginFrame()
        {
            var due = new List<WitnessEvent>();
            lock (Pending)
            {
                for (int i = 0; i < Pending.Count; i++) if (Pending[i].Frame <= Frame) due.Add(Pending[i]);
                if (due.Count > 0) Pending.RemoveAll(e => e.Frame <= Frame);
            }
            _frameEvents = due;
            return due;
        }

        /// <summary>The queued events whose frame is due at <paramref name="frame"/> (pull-style input; does not remove them).</summary>
        public static List<WitnessEvent> InputEvents(int frame)
        {
            lock (Pending) return Pending.FindAll(e => e.Frame <= frame);
        }

        /// <summary>Ends a frame of dt seconds: advances Frame/Time and syncs audio capture.</summary>
        public static void EndFrame(double dt)
        {
            Frame++;
            Time += dt;
            if (Pcm != null) Pcm.SyncTo(Time);
        }

        /// <summary>The per-frame dts of a step command: "dts" wins over "dt", which wins over 1/fps.</summary>
        public static double[] StepDts(WitnessCommand cmd)
        {
            int frames = (int)Math.Max(1, cmd.Long("frames", 1));
            double dt = cmd.Double("dt", 0);
            if (dt <= 0) dt = 1.0 / Math.Max(1, _hello != null ? _hello.Fps : 60);
            var dts = cmd.List("dts");
            var o = new double[frames];
            for (int i = 0; i < frames; i++) o[i] = dts != null && i < dts.Count ? WitnessJson.Double(dts[i], dt) : dt;
            return o;
        }

        /// <summary>{"frame", "time"}: the reply fields of step, the start of snapshot.</summary>
        public static Dictionary<string, object> Clock()
        {
            return new Dictionary<string, object> { { "frame", Frame }, { "time", Time } };
        }

        // ------------------------------------------------------------------ logs

        /// <summary>A log line for the CLI ("info" | "warn" | "error"). Errors fail tests. No-op when inactive.</summary>
        public static void Log(string level, string message)
        {
            if (!_connected) return;
            lock (Logs) Logs.Add(new Dictionary<string, object> { { "frame", Frame }, { "level", level ?? "info" }, { "message", message ?? "" } });
        }

        public static void Info(string message) { Log("info", message); }
        public static void Warn(string message) { Log("warn", message); }
        public static void Error(string message) { Log("error", message); }

        // ------------------------------------------------------------------ sound events

        /// <summary>
        /// Announces a sound the game just started ("jump", "coin"): one {"event":"sound"} line, sent at once and
        /// stamped with <see cref="Frame"/> (the frame being simulated). Optional; no-op unless connected.
        /// volume: 0..1 (negative = not given). x, y: screen position in pixels (NaN = not given).
        /// </summary>
        public static void Sound(string name, double volume = -1, double x = double.NaN, double y = double.NaN)
        {
            if (!_connected || string.IsNullOrEmpty(name)) return;
            SendLine(SoundJson(name, Frame, volume, x, y));
        }

        /// <summary>The protocol line Sound sends (docs/PROTOCOL.md section 3).</summary>
        internal static string SoundJson(string name, int frame, double volume = -1, double x = double.NaN, double y = double.NaN)
        {
            var o = new Dictionary<string, object> { { "event", "sound" }, { "name", name ?? "" }, { "frame", frame } };
            if (volume >= 0) o["volume"] = Math.Min(1.0, volume);
            if (!double.IsNaN(x) && !double.IsNaN(y) && !double.IsInfinity(x) && !double.IsInfinity(y)) o["pos"] = new[] { x, y };
            return WitnessJson.Write(o);
        }

        private static List<Dictionary<string, object>> DrainLogs()
        {
            lock (Logs)
            {
                var o = new List<Dictionary<string, object>>(Logs);
                Logs.Clear();
                return o;
            }
        }

        // ------------------------------------------------------------------ recording (protocol section 5)

        /// <summary>Starts recording to WITNESS_RECORD if it is set (Start does this). Returns true if recording.</summary>
        public static bool StartRecording(WitnessHello hello)
        {
            if (_rec != null) return true;
            string path = Env("WITNESS_RECORD");
            if (string.IsNullOrEmpty(path) || Active) return false;
            try
            {
                string dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                _rec = new StreamWriter(path, false, new UTF8Encoding(false)) { NewLine = "\n" };
                _recPath = path;
                _endStateWritten = false;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("[witness] can't record to '" + path + "': " + e.Message);
                return false;
            }
            hello = hello ?? new WitnessHello();
            var head = new Dictionary<string, object>
            {
                { "replay", 1 }, { "name", hello.Name }, { "seed", Seed }, { "fps", hello.Fps },
                { "started", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture) },
            };
            _rec.WriteLine(WitnessJson.Write(head));
            _rec.Flush();
            _recFrame = 0;
            _recTime = 0;
            AppDomain.CurrentDomain.ProcessExit += (s, e) => StopRecording();
            return true;
        }

        /// <summary>
        /// Normal play: append one replay line for the frame just simulated, with the events queued by
        /// RecordEvent/RecordTouch followed by <paramref name="events"/>. Mouse events synthesized from touch
        /// (FromTouch) are skipped: on replay the mouse fallback recreates them. No-op unless recording.
        /// </summary>
        public static void RecordFrame(double dt, IList<WitnessEvent> events = null)
        {
            var rec = _rec;
            if (rec == null) return;
            var sb = new StringBuilder(48);
            sb.Append("{\"f\":").Append(_recFrame.ToString(CultureInfo.InvariantCulture)).Append(",\"dt\":");
            WitnessJson.WriteValue(sb, dt, 0);
            var list = new List<object>();
            lock (RecQueue)
            {
                foreach (var e in RecQueue) list.Add(e.ToJson(false));
                RecQueue.Clear();
            }
            if (events != null)
                foreach (var e in events)
                    if (e != null && !(e.Type == "mouse" && e.FromTouch)) list.Add(e.ToJson(false));
            if (list.Count > 0)
            {
                sb.Append(",\"in\":");
                WitnessJson.WriteValue(sb, list, 0);
            }
            if (_recMark != null)
            {
                sb.Append(",\"mark\":");
                WitnessJson.WriteString(sb, _recMark);
            }
            sb.Append('}');
            lock (rec)
            {
                rec.WriteLine(sb.ToString());
                rec.Flush();   // every line: a crash must not take the last frames with it
            }
            _recMark = null;
            _recFrame++;
            _recTime += dt;
            if (_endStateWritten)
            {
                // the game played on after writing its end state (quit vetoed): that state is no longer the end
                _endStateWritten = false;
                try { File.Delete(_recPath + ".state.json"); } catch (Exception) { /* best effort */ }
            }
        }

        /// <summary>
        /// Normal play: queues an event for the next RecordFrame line (for event pumps that see input one event
        /// at a time). FromTouch mouse events are ignored. No-op unless recording.
        /// </summary>
        public static void RecordEvent(WitnessEvent e)
        {
            if (_rec == null || e == null || (e.Type == "mouse" && e.FromTouch)) return;
            lock (RecQueue) RecQueue.Add(e);
        }

        /// <summary>
        /// Normal play: queues a finger for the next RecordFrame line. id 0 = the first finger down; x/y in the
        /// same logical pixels Witness injects (convert from the engine's screen or normalized coordinates).
        /// Record a touch the system ended (SDL's FINGER_CANCELED, Unity's TouchPhase.Canceled) as Cancel: it
        /// replays as "cancel". Don't also record the mouse events the platform synthesizes from touch. No-op
        /// unless recording.
        /// </summary>
        public static void RecordTouch(int id, double x, double y, WitnessTouchPhase phase, double pressure = 1)
        {
            if (_rec == null) return;
            RecordEvent(WitnessEvent.TouchEvent(id, x, y, phase, pressure));
        }

        /// <summary>Flags the current frame in the replay (the game calls this on F8).</summary>
        public static void Mark(string label = "F8")
        {
            if (_rec != null) _recMark = label ?? "mark";
        }

        /// <summary>
        /// Writes &lt;recording&gt;.state.json: the game state the recording ended in ({"frame", "time", "state"}),
        /// which `witness replay` compares field by field to the replay's final state. Call it right after the
        /// last RecordFrame (before or after StopRecording: the path is kept) with what the Snapshot handler
        /// returns. A frame recorded after it deletes it again (stale). No-op (false) unless this run recorded.
        /// </summary>
        public static bool WriteEndState(object state)
        {
            string path = _recPath;
            if (path == null) return false;
            var o = new Dictionary<string, object> { { "frame", _recFrame }, { "time", _recTime }, { "state", state } };
            try { File.WriteAllText(path + ".state.json", WitnessJson.Write(o), new UTF8Encoding(false)); _endStateWritten = _rec != null; return true; }
            catch (Exception e) { Console.Error.WriteLine("[witness] can't write " + path + ".state.json: " + e.Message); return false; }
        }

        public static void StopRecording()
        {
            var rec = _rec;
            _rec = null;
            if (rec == null) return;
            lock (rec)
            {
                try { rec.Flush(); rec.Dispose(); } catch (Exception) { /* exiting */ }
            }
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>Base64 of interleaved floats as little-endian f32 (the protocol's audio format).</summary>
        public static string Base64F32(float[] samples)
        {
            var bytes = new byte[samples.Length * 4];
            Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
            if (!BitConverter.IsLittleEndian)
                for (int i = 0; i < bytes.Length; i += 4) { Array.Reverse(bytes, i, 4); }
            return Convert.ToBase64String(bytes);
        }

        public static string Base64(byte[] bytes) { return Convert.ToBase64String(bytes); }

        internal static void SendLine(string json)
        {
            var s = _stream;
            if (s == null) return;
            var bytes = Encoding.UTF8.GetBytes(json + "\n");
            lock (WriteGate)
            {
                try
                {
                    s.Write(bytes, 0, bytes.Length);
                    s.Flush();
                }
                catch (Exception) { MarkDisconnected(); }
            }
        }

        private static void StepFrames(WitnessCommand cmd, WitnessHandlers h)
        {
            foreach (double dt in StepDts(cmd))
            {
                var due = BeginFrame();
                if (h.Input != null) foreach (var e in due) h.Input(e);
                h.Step(dt);
                EndFrame(dt);
            }
        }

        private static object FilterPaths(object state, List<object> paths)
        {
            var d = state as IDictionary;
            if (paths == null || paths.Count == 0 || d == null) return state;
            var o = new Dictionary<string, object>();
            foreach (var p in paths)
            {
                string key = Convert.ToString(p, CultureInfo.InvariantCulture) ?? "";
                if (key.StartsWith("state.", StringComparison.Ordinal)) key = key.Substring(6);
                int cut = key.IndexOfAny(new[] { '.', '[' });
                if (cut >= 0) key = key.Substring(0, cut);
                if (d.Contains(key)) o[key] = d[key];
            }
            return o;
        }

        private static Dictionary<string, object> ImageJson(WitnessImage img)
        {
            var o = new Dictionary<string, object>();
            if (img.Width > 0) o["width"] = img.Width;
            if (img.Height > 0) o["height"] = img.Height;
            if (img.Path != null) o["path"] = img.Path;
            else if (img.Png != null) { o["format"] = "png"; o["data"] = Convert.ToBase64String(img.Png); }
            else { o["format"] = "rgba8"; o["data"] = Convert.ToBase64String(img.Rgba, 0, img.Width * img.Height * 4); }
            return o;
        }

        private static Dictionary<string, object> AudioJson(WitnessAudio au)
        {
            return new Dictionary<string, object>
            {
                { "sampleRate", au.SampleRate }, { "channels", au.Channels }, { "format", "f32" },
                { "data", Base64F32(au.Samples ?? new float[0]) },
            };
        }

        private static string HelloJson(WitnessHello hello, WitnessHandlers h)
        {
            var caps = hello.Capabilities;
            if (caps == null)
            {
                caps = new List<string> { "reset", "step", "input", "snapshot" };
                if (h != null)
                {
                    if (h.Screenshot != null) caps.Add("screenshot");
                    if (h.Audio != null || Pcm != null) caps.Add("audio");
                    if (h.Call != null) caps.Add("call");
                    if (h.Eval != null) caps.Add("eval");
                    if (h.Perf != null) caps.Add("perf");
                }
                caps.Add("logs");
            }
            var calls = new List<object>();
            foreach (var c in hello.Calls ?? new List<WitnessCall>())
            {
                var d = new Dictionary<string, object> { { "name", c.Name } };
                if (c.Args != null) d["args"] = c.Args;
                if (c.Help != null) d["help"] = c.Help;
                calls.Add(d);
            }
            var o = new Dictionary<string, object>
            {
                { "protocol", Protocol }, { "name", hello.Name }, { "engine", hello.Engine }, { "language", hello.Language },
                { "fps", hello.Fps }, { "capabilities", caps }, { "calls", calls },
            };
            if (hello.Width > 0 && hello.Height > 0) o["size"] = new[] { hello.Width, hello.Height };
            if (hello.Keys != null) o["keys"] = hello.Keys;
            if (hello.Touch) o["touch"] = true;
            return WitnessJson.Write(new Dictionary<string, object> { { "hello", o } });
        }

        private static void ReadLoop()
        {
            var line = new MemoryStream();
            var chunk = new byte[16384];
            var s = _stream;
            try
            {
                for (;;)
                {
                    int n = s.Read(chunk, 0, chunk.Length);
                    if (n <= 0) break;
                    for (int i = 0; i < n; i++)
                    {
                        if (chunk[i] != (byte)'\n') { line.WriteByte(chunk[i]); continue; }
                        string text = Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length).Trim();
                        line.SetLength(0);
                        if (text.Length > 0) Enqueue(text);
                    }
                }
            }
            catch (Exception) { /* socket closed */ }
            MarkDisconnected();
        }

        private static void Enqueue(string text)
        {
            if (text.StartsWith("@w", StringComparison.Ordinal)) text = text.Substring(2);
            Dictionary<string, object> msg;
            try { msg = WitnessJson.Parse(text) as Dictionary<string, object>; }
            catch (FormatException) { return; }
            if (msg == null) return;
            var cmd = new WitnessCommand(WitnessJson.Long(WitnessJson.Get(msg, "id"), 0), WitnessJson.Str(WitnessJson.Get(msg, "cmd")) ?? "", msg);
            lock (Gate)
            {
                Inbox.Enqueue(cmd);
                Monitor.PulseAll(Gate);
            }
        }

        private static void MarkDisconnected()
        {
            _connected = false;
            lock (Gate) Monitor.PulseAll(Gate);
        }

        private static void Disconnect()
        {
            var c = _client;
            _client = null;
            _stream = null;
            MarkDisconnected();
            if (c != null) { try { c.Close(); } catch (Exception) { /* already gone */ } }
        }

        private static string Env(string name)
        {
            try { return Environment.GetEnvironmentVariable(name); }
            catch (Exception) { return null; }
        }
    }

    /// <summary>
    /// Maps between Witness key names ("right", "space", "1", "shift", "f8") and engine key enums.
    /// Works with any enum by name: UnityEngine.KeyCode, UnityEngine.InputSystem.Key, Godot.Key,
    /// Microsoft.Xna.Framework.Input.Keys (MonoGame/FNA), System.ConsoleKey, WinForms Keys.
    /// </summary>
    public static class WitnessKeys
    {
        private static readonly Dictionary<string, string> ToWitness = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "leftarrow", "left" }, { "rightarrow", "right" }, { "uparrow", "up" }, { "downarrow", "down" },
            { "return", "enter" }, { "keypadenter", "enter" }, { "numpadenter", "enter" }, { "kpenter", "enter" },
            { "esc", "escape" }, { "spacebar", "space" }, { "back", "backspace" },
            { "leftshift", "shift" }, { "rightshift", "shift" }, { "lshift", "shift" }, { "rshift", "shift" }, { "shiftkey", "shift" },
            { "leftcontrol", "ctrl" }, { "rightcontrol", "ctrl" }, { "leftctrl", "ctrl" }, { "rightctrl", "ctrl" },
            { "lcontrol", "ctrl" }, { "rcontrol", "ctrl" }, { "control", "ctrl" }, { "controlkey", "ctrl" }, { "lctrl", "ctrl" }, { "rctrl", "ctrl" },
            { "leftalt", "alt" }, { "rightalt", "alt" }, { "lalt", "alt" }, { "ralt", "alt" }, { "altgr", "alt" }, { "menu", "alt" },
            { "lmenu", "alt" }, { "rmenu", "alt" }, { "leftoption", "alt" }, { "rightoption", "alt" },
            // the OS key is "meta" (as in the JS and Godot adapters): Unity LeftCommand/LeftWindows, MonoGame LeftWindows
            { "super", "meta" }, { "leftmeta", "meta" }, { "rightmeta", "meta" }, { "leftcommand", "meta" }, { "rightcommand", "meta" },
            { "leftwindows", "meta" }, { "rightwindows", "meta" }, { "lwin", "meta" }, { "rwin", "meta" }, { "leftapple", "meta" },
            { "rightapple", "meta" }, { "command", "meta" }, { "cmd", "meta" }, { "windows", "meta" }, { "leftsuper", "meta" },
            { "rightsuper", "meta" }, { "superleft", "meta" }, { "superright", "meta" }, { "lsuper", "meta" }, { "rsuper", "meta" },
        };

        private static readonly Dictionary<string, string[]> FromWitness = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            { "left", new[] { "Left", "LeftArrow" } }, { "right", new[] { "Right", "RightArrow" } },
            { "up", new[] { "Up", "UpArrow" } }, { "down", new[] { "Down", "DownArrow" } },
            { "enter", new[] { "Enter", "Return" } }, { "escape", new[] { "Escape", "Esc" } },
            { "space", new[] { "Space", "Spacebar" } }, { "backspace", new[] { "Backspace", "Back" } }, { "tab", new[] { "Tab" } },
            { "shift", new[] { "LeftShift", "Shift", "LShift", "ShiftKey" } },
            { "ctrl", new[] { "LeftControl", "LeftCtrl", "Ctrl", "Control", "LControl", "ControlKey" } },
            { "alt", new[] { "LeftAlt", "Alt", "LAlt", "LMenu", "Menu" } },
            { "meta", new[] { "Meta", "LeftMeta", "LeftCommand", "LeftWindows", "LWin", "Super" } },
            { "super", new[] { "Meta", "LeftMeta", "LeftCommand", "LeftWindows", "LWin", "Super" } },
        };

        /// <summary>Engine key name (e.g. KeyCode.RightArrow.ToString()) → Witness name ("right").</summary>
        public static string Normalize(string engineName)
        {
            if (string.IsNullOrEmpty(engineName)) return "";
            string k = engineName.Replace("_", "").Replace(" ", "");
            string mapped;
            if (ToWitness.TryGetValue(k, out mapped)) return mapped;
            string lower = k.ToLowerInvariant();
            foreach (var prefix in new[] { "alpha", "digit", "key", "d", "num" })
                if (lower.Length == prefix.Length + 1 && lower.StartsWith(prefix, StringComparison.Ordinal) && char.IsDigit(lower[prefix.Length]))
                    return lower.Substring(prefix.Length);
            return lower;
        }

        /// <summary>Witness name → enum member names to try, most likely first.</summary>
        public static string[] Candidates(string witnessName)
        {
            if (string.IsNullOrEmpty(witnessName)) return new string[0];
            string[] c;
            if (FromWitness.TryGetValue(witnessName, out c)) return c;
            if (witnessName.Length == 1 && char.IsDigit(witnessName[0]))
                return new[] { "Alpha" + witnessName, "D" + witnessName, "Digit" + witnessName, "Key" + witnessName, "Num" + witnessName };
            if (witnessName.Length == 1) return new[] { witnessName.ToUpperInvariant() };
            return new[] { char.ToUpperInvariant(witnessName[0]) + witnessName.Substring(1) };
        }

        /// <summary>Witness name → engine enum value, e.g. TryParse("right", out KeyCode k) gives KeyCode.RightArrow.</summary>
        public static bool TryParse<T>(string witnessName, out T value) where T : struct
        {
            foreach (var name in Candidates(witnessName))
            {
                if (name.Length == 0 || char.IsDigit(name[0]) || name[0] == '-') continue;   // never parse "1" as the value 1
                if (Enum.TryParse(name, true, out value) && Enum.IsDefined(typeof(T), value)) return true;
            }
            value = default(T);
            return false;
        }
    }

    /// <summary>A strict, allocation-light JSON reader and writer (no System.Text.Json; Unity has none).</summary>
    public static class WitnessJson
    {
        /// <summary>Objects → Dictionary&lt;string, object&gt;, arrays → List&lt;object&gt;, integers → long, other numbers → double.</summary>
        public static object Parse(string text)
        {
            int i = 0;
            object v = ParseValue(text, ref i);
            SkipWs(text, ref i);
            if (i != text.Length) throw new FormatException("unexpected trailing characters at " + i);
            return v;
        }

        public static string Write(object value)
        {
            var sb = new StringBuilder(256);
            WriteValue(sb, value, 0);
            return sb.ToString();
        }

        public static object Get(IDictionary<string, object> o, string key)
        {
            object v;
            return o != null && o.TryGetValue(key, out v) ? v : null;
        }

        public static string Str(object v) { return v == null ? null : v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture); }

        public static double Double(object v, double fallback)
        {
            if (v is double) return (double)v;
            if (v is long) return (long)v;
            double d;
            var s = v as string;
            if (s != null && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            if (v is IConvertible && !(v is bool)) { try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch (Exception) { } }
            return fallback;
        }

        public static long Long(object v, long fallback)
        {
            if (v is long) return (long)v;
            if (v is double) return (long)Math.Round((double)v);
            var s = v as string;
            long l;
            if (s != null && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out l)) return l;
            double d = Double(v, double.NaN);
            return double.IsNaN(d) ? fallback : (long)Math.Round(d);
        }

        // ---------------------------------------------------------------- writer

        public static void WriteValue(StringBuilder sb, object v, int depth)
        {
            if (depth > 64) { sb.Append("\"<too deep>\""); return; }
            if (v == null) { sb.Append("null"); return; }
            var s = v as string;
            if (s != null) { WriteString(sb, s); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is double) { WriteDouble(sb, (double)v); return; }
            if (v is float) { WriteFloat(sb, (float)v); return; }
            if (v is int || v is long || v is short || v is byte || v is sbyte || v is ushort || v is uint || v is ulong)
            {
                sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
                return;
            }
            if (v is decimal) { sb.Append(((decimal)v).ToString(CultureInfo.InvariantCulture)); return; }
            if (v is char) { WriteString(sb, v.ToString()); return; }
            if (v is Enum) { WriteString(sb, v.ToString()); return; }
            var dict = v as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry kv in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, Convert.ToString(kv.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    WriteValue(sb, kv.Value, depth + 1);
                }
                sb.Append('}');
                return;
            }
            var seq = v as IEnumerable;
            if (seq != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in seq)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item, depth + 1);
                }
                sb.Append(']');
                return;
            }
            WriteObject(sb, v, depth);
        }

        public static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        private static void WriteDouble(StringBuilder sb, double d)
        {
            if (double.IsNaN(d)) sb.Append("\"NaN\"");
            else if (double.IsPositiveInfinity(d)) sb.Append("\"Infinity\"");
            else if (double.IsNegativeInfinity(d)) sb.Append("\"-Infinity\"");
            else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void WriteFloat(StringBuilder sb, float f)
        {
            if (float.IsNaN(f) || float.IsInfinity(f)) WriteDouble(sb, f);
            else sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
        }

        // Vectors (Unity, Godot, MonoGame, System.Numerics) become [x, y(, z(, w))]; other objects
        // become {publicField: value} over their public instance fields (properties are skipped: they
        // can be expensive, throw, or recurse, e.g. Vector3.normalized).
        private static void WriteObject(StringBuilder sb, object v, int depth)
        {
            var t = v.GetType();
            if (t.Name.StartsWith("Vector", StringComparison.Ordinal) || t.Name == "Point" || t.Name == "Quaternion")
            {
                var parts = new List<object>(4);
                foreach (var axis in new[] { "x", "y", "z", "w" })
                {
                    object c;
                    if (!TryMember(v, t, axis, out c)) break;
                    parts.Add(c);
                }
                if (parts.Count >= 2) { WriteValue(sb, parts, depth + 1); return; }
            }
            sb.Append('{');
            bool first = true;
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!first) sb.Append(',');
                first = false;
                WriteString(sb, f.Name);
                sb.Append(':');
                WriteValue(sb, f.GetValue(v), depth + 1);
            }
            sb.Append('}');
        }

        private static bool TryMember(object v, Type t, string axis, out object value)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase;
            var f = t.GetField(axis, flags);
            if (f != null) { value = f.GetValue(v); return true; }
            var p = t.GetProperty(axis, flags);
            if (p != null && p.GetIndexParameters().Length == 0) { value = p.GetValue(v, null); return true; }
            value = null;
            return false;
        }

        // ---------------------------------------------------------------- reader

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end of JSON");
            char c = s[i];
            if (c == '{') return ParseObject(s, ref i);
            if (c == '[') return ParseArray(s, ref i);
            if (c == '"') return ParseString(s, ref i);
            if (c == 't') return Literal(s, ref i, "true", true);
            if (c == 'f') return Literal(s, ref i, "false", false);
            if (c == 'n') return Literal(s, ref i, "null", null);
            if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber(s, ref i);
            throw new FormatException("unexpected '" + c + "' at " + i);
        }

        private static object Literal(string s, ref int i, string word, object value)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new FormatException("bad literal at " + i);
            i += word.Length;
            return value;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var o = new Dictionary<string, object>();
            i++;
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return o; }
            for (;;)
            {
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("expected a key at " + i);
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':' at " + i);
                i++;
                o[key] = ParseValue(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("unterminated object");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return o; }
                throw new FormatException("expected ',' or '}' at " + i);
            }
        }

        private static List<object> ParseArray(string s, ref int i)
        {
            var a = new List<object>();
            i++;
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return a; }
            for (;;)
            {
                a.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("unterminated array");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return a; }
                throw new FormatException("expected ',' or ']' at " + i);
            }
        }

        private static string ParseString(string s, ref int i)
        {
            i++;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("bad \\u escape");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("bad escape '\\" + e + "'");
                }
            }
            throw new FormatException("unterminated string");
        }

        private static object ParseNumber(string s, ref int i)
        {
            int start = i;
            bool integral = true;
            if (s[i] == '-') i++;
            while (i < s.Length)
            {
                char c = s[i];
                if (c >= '0' && c <= '9') { i++; continue; }
                if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { integral = false; i++; continue; }
                break;
            }
            string num = s.Substring(start, i - start);
            long l;
            if (integral && long.TryParse(num, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out l)) return l;
            double d;
            if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            throw new FormatException("bad number '" + num + "' at " + start);
        }
    }
}
