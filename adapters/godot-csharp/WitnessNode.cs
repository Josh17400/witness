// WitnessNode.cs: the Witness bridge for Godot 4 (.NET). Add it as an autoload; it reuses Witness.cs.
//
// Project Settings > Autoload: Name "Witness", Path "res://addons/witness/WitnessNode.cs" (or in project.godot:
//   [autoload]  Witness="*res://addons/witness/WitnessNode.cs")
// Launch for Witness with fixed frame timing (required):
//   godot --headless --path . --fixed-fps 60          (no screenshots; drop --headless to get them)
//
// What it does in witness mode (WITNESS_ADDR set): pauses the SceneTree between commands, blocks the
// main loop at the end of each frame while it serves commands, runs exactly N frames per `step`
// (one physics tick + one process call each, dt via Engine.TimeScale), injects input through
// Input.ParseInputEvent at the start of each frame, reloads the scene on `reset` (seeding GD.Seed),
// captures the viewport for screenshots and forwards engine errors to the CLI.
// Touch: "touch" events become InputEventScreenTouch / InputEventScreenDrag. The mouse fallback is Godot's
// own (Project Settings > Input Devices > Pointing > Emulate Mouse From Touch, on by default); turning it
// off is the opt-out, and the hello then says "touch": true.
// When inactive it disables its own processing: zero per-frame cost.
using System;
using System.Collections.Generic;
using Godot;
using WitnessKit;

/// <summary>Implement on the current scene's root (whole snapshot) or on nodes in group "witness" (extra entity fields).</summary>
public interface IWitnessState
{
    object WitnessState();
}

public partial class WitnessNode : Node
{
    /// <summary>Edit before the first frame ends (e.g. in your main scene's _Ready). Fps and Size default to the project settings.</summary>
    public static readonly WitnessHello Hello = new WitnessHello { Name = (string)ProjectSettings.GetSetting("application/config/name", "Godot game"), Language = "c#" };

    /// <summary>Optional: replaces the default snapshot (scene root's IWitnessState, else group "witness" entities).</summary>
    public static Func<object> Snapshot;

    /// <summary>Optional: a synchronous reset (seed, scene, params). Default: reload the current scene (or load `scene`).</summary>
    public static Action<int, string, Dictionary<string, object>> Reset;

    /// <summary>Optional: game-specific perf counters, merged into the perf reply.</summary>
    public static Func<object> Perf;

    private static readonly Dictionary<string, Func<List<object>, object>> CallTable = new Dictionary<string, Func<List<object>, object>>();
    private static readonly HashSet<Key> HeldKeys = new HashSet<Key>();

    private WitnessHandlers _handlers;
    private WitnessCommand _step;
    private double[] _dts;
    private int _stepIndex;
    private bool _frameInputDone;
    private WitnessCommand _resetCmd;
    private Node _oldScene;
    private int _resetWaits;
    private int _fps = 60;
    private bool _started;
    private Vector2 _mouse;
    private MouseButtonMask _buttons;
    private readonly Dictionary<int, Vector2> _fingers = new Dictionary<int, Vector2>();   // finger id -> last position
    private readonly List<WitnessEvent> _recordEvents = new List<WitnessEvent>();

    /// <summary>Registers a custom command for `witness call name args`. Safe to call again after a scene reload.</summary>
    public static void RegisterCall(string name, string args, string help, Func<List<object>, object> fn)
    {
        if (!CallTable.ContainsKey(name)) Hello.Calls.Add(new WitnessCall(name, args, help));
        CallTable[name] = fn;
    }

    public override void _Ready()
    {
        if (!Witness.Active)
        {
            bool recording = Witness.StartRecording(HelloWithDefaults());
            SetProcess(recording);
            SetPhysicsProcess(false);
            SetProcessInput(recording);
            if (recording) ProcessPriority = int.MaxValue;
            return;
        }
        ProcessMode = ProcessModeEnum.Always;
        ProcessPriority = int.MaxValue;              // _Process runs last: the end of a frame
        ProcessPhysicsPriority = int.MinValue;       // _PhysicsProcess runs first: the start of a frame
        SetProcessInput(false);
        _fps = Engine.PhysicsTicksPerSecond;
        Engine.PhysicsJitterFix = 0;
        Input.UseAccumulatedInput = false;
        GetTree().Paused = true;                     // nothing advances until the first step
        OS.AddLogger(new WitnessLogger());
        _handlers = new WitnessHandlers
        {
            Snapshot = TakeSnapshot,
            Screenshot = DisplayServer.GetName() == "headless" ? null : (Func<double, WitnessImage>)CaptureViewport,   // no renderer under --headless
            Call = (name, args) =>
            {
                Func<List<object>, object> fn;
                if (!CallTable.TryGetValue(name, out fn)) throw new ArgumentException("unknown call '" + name + "'");
                return fn(args);
            },
            Perf = () => Perf != null ? Perf() : new Dictionary<string, object>
            {
                { "frame_ms", Performance.GetMonitor(Performance.Monitor.TimeProcess) * 1000 },
                { "counts", new Dictionary<string, object> { { "nodes", (long)Performance.GetMonitor(Performance.Monitor.ObjectNodeCount) } } },
            },
            Quit = () => GetTree().Quit(),
        };
    }

    public override void _ExitTree()
    {
        Witness.StopRecording();   // .NET's ProcessExit doesn't fire when Godot quits
    }

    public override void _PhysicsProcess(double delta)
    {
        if (_step != null && !_frameInputDone) ApplyFrameInput();
    }

    public override void _Process(double delta)
    {
        if (!Witness.Active)
        {
            Witness.RecordFrame(delta, _recordEvents);
            _recordEvents.Clear();
            return;
        }
        if (!_started && !Start()) return;
        if (_step != null)
        {
            if (!_frameInputDone) ApplyFrameInput();   // a frame without a physics tick (shouldn't happen with --fixed-fps)
            Witness.EndFrame(_dts[_stepIndex]);
            _frameInputDone = false;
            if (++_stepIndex < _dts.Length)
            {
                Engine.TimeScale = _dts[_stepIndex] * _fps;
                return;
            }
            Engine.TimeScale = 1;
            GetTree().Paused = true;
            var done = _step;
            _step = null;
            done.Reply(Witness.Clock());
        }
        if (_resetCmd != null && !FinishReset()) return;
        Serve();
    }

    // Normal play with WITNESS_RECORD: collect this frame's input for the replay. Emulated events (Device -1,
    // InputEvent.DeviceIdEmulation: the mouse Godot makes from touch, or touch made from the mouse) are skipped;
    // on replay Godot emulates them again from the recorded real events.
    public override void _Input(InputEvent e)
    {
        var key = e as InputEventKey;
        if (key != null && !key.Echo)
        {
            if (key.Pressed && key.Keycode == Key.F8) { Witness.Mark("F8"); return; }
            _recordEvents.Add(WitnessEvent.KeyEvent(WitnessKeys.Normalize(key.Keycode.ToString()), key.Pressed));
            return;
        }
        if (e.Device == -1) return;
        var st = e as InputEventScreenTouch;
        if (st != null)
        {
            _recordEvents.Add(WitnessEvent.TouchEvent(st.Index, st.Position.X, st.Position.Y, st.Pressed ? WitnessTouchPhase.Down : WitnessTouchPhase.Up));
            return;
        }
        var sd = e as InputEventScreenDrag;
        if (sd != null)
        {
            _recordEvents.Add(WitnessEvent.TouchEvent(sd.Index, sd.Position.X, sd.Position.Y, WitnessTouchPhase.Move, sd.Pressure > 0 ? sd.Pressure : 1));
            return;
        }
        var mb = e as InputEventMouseButton;
        if (mb != null && mb.ButtonIndex <= MouseButton.Middle)
        {
            int button = mb.ButtonIndex == MouseButton.Left ? 0 : mb.ButtonIndex == MouseButton.Middle ? 1 : 2;
            _recordEvents.Add(new WitnessEvent { Type = "mouse", X = mb.Position.X, Y = mb.Position.Y, Button = button, Down = mb.Pressed });
        }
    }

    // ------------------------------------------------------------------ session

    private bool Start()
    {
        _started = true;
        if (Array.IndexOf(OS.GetCmdlineArgs(), "--fixed-fps") < 0)
            GD.PushWarning("[witness] launch Godot with --fixed-fps " + _fps + " so every frame has the same dt and one physics tick");
        if (!Witness.Connect(HelloWithDefaults(), _handlers))
        {
            GD.PushError("[witness] could not connect to the Witness CLI at " + Witness.Address);
            GetTree().Quit(1);
            return false;
        }
        if (_handlers.Screenshot == null) Witness.Info("screenshots are off: Godot runs --headless (no renderer)");
        return true;
    }

    private WitnessHello HelloWithDefaults()
    {
        if (string.IsNullOrEmpty(Hello.Engine) || Hello.Engine == "custom") Hello.Engine = "Godot " + (string)Engine.GetVersionInfo()["string"] + " (.NET)";
        Hello.Fps = Engine.PhysicsTicksPerSecond;
        // Godot makes the mouse from touch itself; with that off the game reads touch natively (no fallback)
        Hello.Touch = !(bool)ProjectSettings.GetSetting("input_devices/pointing/emulate_mouse_from_touch", true);
        if (Hello.Width <= 0)
        {
            Hello.Width = (int)ProjectSettings.GetSetting("display/window/size/viewport_width", 1152);
            Hello.Height = (int)ProjectSettings.GetSetting("display/window/size/viewport_height", 648);
        }
        return Hello;
    }

    // Blocks the main loop (the SceneTree is paused) and answers commands until one needs frames to run.
    private void Serve()
    {
        for (;;)
        {
            var cmd = Witness.Next();
            if (cmd == null)
            {
                GetTree().Quit();   // the CLI went away
                return;
            }
            switch (cmd.Name)
            {
                case "step":
                    _dts = Witness.StepDts(cmd);
                    _stepIndex = 0;
                    _step = cmd;
                    Engine.TimeScale = _dts[0] * _fps;
                    GetTree().Paused = false;
                    return;
                case "reset":
                    if (BeginReset(cmd)) return;
                    break;
                case "quit":
                    Witness.Handle(cmd, _handlers);
                    return;
                default:
                    Witness.Handle(cmd, _handlers);
                    break;
            }
        }
    }

    // Returns true when the reset needs a frame to finish (scene reload), false when it was answered.
    private bool BeginReset(WitnessCommand cmd)
    {
        int seed = (int)cmd.Long("seed", 1);
        Witness.ResetClock(seed);
        GD.Seed((ulong)(uint)seed);
        ReleaseHeldInput();
        string scene = cmd.String("scene");
        try
        {
            if (Reset != null)
            {
                Reset(seed, scene, cmd.Object("params"));
                cmd.Reply();
                return false;
            }
            _oldScene = GetTree().CurrentScene;
            Error err = string.IsNullOrEmpty(scene) ? GetTree().ReloadCurrentScene()
                : GetTree().ChangeSceneToFile(scene.StartsWith("res://", StringComparison.Ordinal) ? scene : "res://" + scene + (scene.EndsWith(".tscn", StringComparison.Ordinal) ? "" : ".tscn"));
            if (err != Error.Ok)
            {
                cmd.Fail("couldn't load the scene: " + err);
                return false;
            }
        }
        catch (Exception e)
        {
            cmd.Fail(e.GetType().Name + ": " + e.Message);
            return false;
        }
        _resetCmd = cmd;
        _resetWaits = 0;
        return true;   // the change happens during the next (paused) frame
    }

    private bool FinishReset()
    {
        var current = GetTree().CurrentScene;
        bool swapped = current != null && (current != _oldScene || !IsInstanceValid(_oldScene));
        if (!swapped && ++_resetWaits < 10) return false;   // let another paused frame pass
        var cmd = _resetCmd;
        _resetCmd = null;
        _oldScene = null;
        if (swapped) cmd.Reply();
        else cmd.Fail("the scene didn't reload within 10 frames");
        return true;
    }

    // ------------------------------------------------------------------ input

    private void ApplyFrameInput()
    {
        _frameInputDone = true;
        var due = Witness.BeginFrame();
        if (due.Count == 0) return;
        foreach (var e in due) Inject(e);
        Input.FlushBufferedEvents();
    }

    /// <summary>Feeds one Witness event through Godot's normal input path (Input + _input/_unhandled_input).</summary>
    public void Inject(WitnessEvent e)
    {
        switch (e.Type)
        {
            case "key":
            {
                Key key;
                if (!WitnessKeys.TryParse(e.Key, out key)) { Witness.Warn("unknown key '" + e.Key + "'"); return; }
                bool down = e.IsDown;
                if (down) HeldKeys.Add(key); else HeldKeys.Remove(key);
                var ev = new InputEventKey { Keycode = key, PhysicalKeycode = key, Pressed = down };
                if (down && e.Key.Length == 1) ev.Unicode = e.Key[0];
                Input.ParseInputEvent(ev);
                break;
            }
            case "mouse":
            {
                if (e.FromTouch) return;   // Godot emulates the mouse from the touch itself (emulate_mouse_from_touch)
                var pos = new Vector2((float)e.X, (float)e.Y);
                if (e.Down.HasValue)
                {
                    MouseButton mbIndex = e.Button == 1 ? MouseButton.Middle : e.Button == 2 ? MouseButton.Right : MouseButton.Left;
                    MouseButtonMask mask = e.Button == 1 ? MouseButtonMask.Middle : e.Button == 2 ? MouseButtonMask.Right : MouseButtonMask.Left;
                    if (pos != _mouse) Input.ParseInputEvent(new InputEventMouseMotion { Position = pos, GlobalPosition = pos, Relative = pos - _mouse, ButtonMask = _buttons });
                    _buttons = e.IsDown ? _buttons | mask : _buttons & ~mask;
                    Input.ParseInputEvent(new InputEventMouseButton { Position = pos, GlobalPosition = pos, ButtonIndex = mbIndex, Pressed = e.IsDown, ButtonMask = _buttons });
                }
                else
                {
                    Input.ParseInputEvent(new InputEventMouseMotion { Position = pos, GlobalPosition = pos, Relative = pos - _mouse, ButtonMask = _buttons });
                }
                _mouse = pos;
                break;
            }
            case "touch":
            {
                // Same coordinates as the mouse. Godot turns the first finger into mouse events when
                // emulate_mouse_from_touch is on (emulated events have Device == -1).
                var pos = new Vector2((float)e.X, (float)e.Y);
                Vector2 last;
                bool known = _fingers.TryGetValue(e.Id, out last);
                if (e.Phase != WitnessTouchPhase.Down && !known) return;   // a move or lift without a down
                if (e.Phase == WitnessTouchPhase.Move || (e.Phase == WitnessTouchPhase.Up && pos != last))
                {
                    var rel = pos - last;
                    Input.ParseInputEvent(new InputEventScreenDrag { Index = e.Id, Position = pos, Relative = rel, Velocity = rel * _fps, Pressure = (float)e.Pressure });
                }
                if (e.Phase != WitnessTouchPhase.Move)
                    Input.ParseInputEvent(new InputEventScreenTouch { Index = e.Id, Position = pos, Pressed = e.Phase == WitnessTouchPhase.Down });
                if (e.Phase == WitnessTouchPhase.Up) _fingers.Remove(e.Id);
                else _fingers[e.Id] = pos;
                break;
            }
            case "wheel":
            {
                MouseButton dir = e.Dy < 0 ? MouseButton.WheelUp : MouseButton.WheelDown;
                float factor = (float)Math.Max(1, Math.Abs(e.Dy) / 100);
                Input.ParseInputEvent(new InputEventMouseButton { Position = _mouse, GlobalPosition = _mouse, ButtonIndex = dir, Pressed = true, Factor = factor });
                Input.ParseInputEvent(new InputEventMouseButton { Position = _mouse, GlobalPosition = _mouse, ButtonIndex = dir, Pressed = false, Factor = factor });
                break;
            }
            case "text":
                foreach (char c in e.Text ?? "")
                {
                    Input.ParseInputEvent(new InputEventKey { Unicode = c, Pressed = true });
                    Input.ParseInputEvent(new InputEventKey { Unicode = c, Pressed = false });
                }
                break;
            case "action":
                Input.ParseInputEvent(new InputEventAction { Action = e.Action, Pressed = e.IsDown, Strength = e.IsDown ? 1f : 0f });
                break;
            case "pad":
            {
                JoyButton jb;
                if (!PadButtons.TryGetValue(e.PadButton ?? "", out jb)) { Witness.Warn("unknown pad button '" + e.PadButton + "'"); return; }
                Input.ParseInputEvent(new InputEventJoypadButton { ButtonIndex = jb, Pressed = e.IsDown });
                break;
            }
            case "axis":
            {
                JoyAxis axis;
                if (!PadAxes.TryGetValue(e.Axis ?? "", out axis)) { Witness.Warn("unknown pad axis '" + e.Axis + "'"); return; }
                Input.ParseInputEvent(new InputEventJoypadMotion { Axis = axis, AxisValue = (float)e.Value });
                break;
            }
        }
    }

    // A reset must not leave keys, buttons or fingers held from the previous run.
    private void ReleaseHeldInput()
    {
        foreach (var key in HeldKeys) Input.ParseInputEvent(new InputEventKey { Keycode = key, PhysicalKeycode = key, Pressed = false });
        HeldKeys.Clear();
        foreach (var kv in _fingers) Input.ParseInputEvent(new InputEventScreenTouch { Index = kv.Key, Position = kv.Value, Pressed = false });
        _fingers.Clear();
        if (_buttons != 0)
        {
            foreach (var b in new[] { MouseButton.Left, MouseButton.Right, MouseButton.Middle })
                Input.ParseInputEvent(new InputEventMouseButton { Position = _mouse, ButtonIndex = b, Pressed = false });
            _buttons = 0;
        }
        foreach (var action in InputMap.GetActions()) Input.ActionRelease(action);
        Input.FlushBufferedEvents();
    }

    private static readonly Dictionary<string, JoyButton> PadButtons = new Dictionary<string, JoyButton>(StringComparer.OrdinalIgnoreCase)
    {
        { "a", JoyButton.A }, { "b", JoyButton.B }, { "x", JoyButton.X }, { "y", JoyButton.Y },
        { "back", JoyButton.Back }, { "guide", JoyButton.Guide }, { "start", JoyButton.Start },
        { "leftstick", JoyButton.LeftStick }, { "rightstick", JoyButton.RightStick },
        { "leftshoulder", JoyButton.LeftShoulder }, { "rightshoulder", JoyButton.RightShoulder },
        { "dpup", JoyButton.DpadUp }, { "dpdown", JoyButton.DpadDown }, { "dpleft", JoyButton.DpadLeft }, { "dpright", JoyButton.DpadRight },
    };

    private static readonly Dictionary<string, JoyAxis> PadAxes = new Dictionary<string, JoyAxis>(StringComparer.OrdinalIgnoreCase)
    {
        { "leftx", JoyAxis.LeftX }, { "lefty", JoyAxis.LeftY }, { "rightx", JoyAxis.RightX }, { "righty", JoyAxis.RightY },
        { "lefttrigger", JoyAxis.TriggerLeft }, { "righttrigger", JoyAxis.TriggerRight },
    };

    // ------------------------------------------------------------------ snapshot, screenshot, audio

    private object TakeSnapshot()
    {
        if (Snapshot != null) return Snapshot();
        var scene = GetTree().CurrentScene;
        var rootState = scene as IWitnessState;
        if (rootState != null) return rootState.WitnessState();
        var entities = new List<object>();
        foreach (var node in GetTree().GetNodesInGroup("witness"))   // tree order: stable across runs
        {
            var e = new Dictionary<string, object>
            {
                { "id", node.HasMeta("witness_id") ? (object)node.GetMeta("witness_id").ToString() : (scene != null ? scene.GetPathTo(node).ToString() : node.Name.ToString()) },
                { "type", node.HasMeta("witness_type") ? node.GetMeta("witness_type").ToString() : node.GetType().Name },
            };
            var n2 = node as Node2D;
            var n3 = node as Node3D;
            var ctl = node as Control;
            if (n2 != null) e["pos"] = new[] { n2.GlobalPosition.X, n2.GlobalPosition.Y };
            else if (n3 != null) e["pos"] = new[] { n3.GlobalPosition.X, n3.GlobalPosition.Y, n3.GlobalPosition.Z };
            else if (ctl != null) e["pos"] = new[] { ctl.GlobalPosition.X, ctl.GlobalPosition.Y };
            var extra = node as IWitnessState;
            var fields = extra != null ? extra.WitnessState() as System.Collections.IDictionary : null;
            if (fields != null) foreach (System.Collections.DictionaryEntry kv in fields) e[kv.Key.ToString()] = kv.Value;
            entities.Add(e);
        }
        return new Dictionary<string, object> { { "scene", scene != null ? scene.SceneFilePath : null }, { "entities", entities } };
    }

    private WitnessImage CaptureViewport(double scale)
    {
        RenderingServer.ForceDraw(false, 0);
        var img = GetViewport().GetTexture().GetImage();
        if (img == null || img.IsEmpty()) throw new InvalidOperationException("the viewport has no image yet");
        if (img.GetFormat() != Image.Format.Rgba8) img.Convert(Image.Format.Rgba8);
        return WitnessImage.FromRgba(img.GetWidth(), img.GetHeight(), img.GetData());
    }

    /// <summary>
    /// Mixes a WAV stream (8/16-bit PCM) into Witness.Pcm at the current simulated time. Call it next to
    /// AudioStreamPlayer.Play() for sounds tests should hear. No-op unless Witness.Pcm is set.
    /// </summary>
    public static void Mix(AudioStreamWav wav, float volumeDb = 0)
    {
        var pcm = Witness.Pcm;
        if (pcm == null || wav == null) return;
        byte[] data = wav.Data;
        int srcChannels = wav.Stereo ? 2 : 1;
        bool is16 = wav.Format == AudioStreamWav.FormatEnum.Format16Bits;
        if (!is16 && wav.Format != AudioStreamWav.FormatEnum.Format8Bits) { Witness.Warn("Witness can only mix 8/16-bit PCM WAVs"); return; }
        int bytesPerFrame = srcChannels * (is16 ? 2 : 1);
        int srcFrames = data.Length / bytesPerFrame;
        double ratio = (double)wav.MixRate / pcm.SampleRate;
        int outFrames = (int)(srcFrames / ratio);
        float gain = Mathf.DbToLinear(volumeDb);
        var o = new float[outFrames * pcm.Channels];
        for (int f = 0; f < outFrames; f++)
        {
            int sf = Math.Min(srcFrames - 1, (int)(f * ratio));
            for (int c = 0; c < pcm.Channels; c++)
            {
                int sc = Math.Min(c, srcChannels - 1), at = sf * bytesPerFrame + sc * (is16 ? 2 : 1);
                float v = is16 ? (short)(data[at] | data[at + 1] << 8) / 32768f : (sbyte)data[at] / 128f;
                o[f * pcm.Channels + c] = v * gain;
            }
        }
        pcm.Play(o);
    }

    // ------------------------------------------------------------------ logs

    // Engine and script errors (including unhandled C# exceptions) become Witness logs, so they fail tests.
    private sealed partial class WitnessLogger : Logger
    {
        public override void _LogError(string function, string file, int line, string code, string rationale, bool editorNotify, int errorType, Godot.Collections.Array<ScriptBacktrace> scriptBacktraces)
        {
            string message = string.IsNullOrEmpty(rationale) ? code : rationale + " (" + code + ")";
            Witness.Log(errorType == (int)ErrorType.Warning ? "warn" : "error", message + " at " + file + ":" + line);
        }

        public override void _LogMessage(string message, bool error)
        {
            Witness.Log(error ? "warn" : "info", message.TrimEnd('\n'));
        }
    }
}
