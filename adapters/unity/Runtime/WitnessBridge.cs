// WitnessBridge: drives a Unity game for the Witness CLI (protocol v1). No scene setup: it installs
// itself before the first scene loads when WITNESS_ADDR is set (or the player got --witness), or when
// WITNESS_RECORD is set (replay recording during normal play). Otherwise it does nothing at all.
//
// Witness mode, per frame (hooks inserted into the PlayerLoop):
//   EarlyUpdate (first)    apply this frame's input events (Input System state events + InputSystem.Update(),
//                          and WitnessInput for the old Input Manager)
//   FixedUpdate            runs exactly once: Time.captureDeltaTime == Time.fixedDeltaTime == dt
//   PreUpdate (first)      Physics.Simulate(dt) / Physics2D.Simulate(dt) (simulation mode = Script),
//                          i.e. after FixedUpdate scripts, as Unity's own simulation would
//   Update, LateUpdate, rendering
//   PostLateUpdate (last)  capture the frame's audio (AudioRenderer), count the frame, and when the step is
//                          done reply and block, serving commands until the next step or reset.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using Unity.Collections;
using UnityEngine;
using UnityEngine.LowLevel;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace WitnessKit
{
    [AddComponentMenu("")]
    [DisallowMultipleComponent]
    public sealed class WitnessBridge : MonoBehaviour
    {
        public enum ScreenshotSource
        {
            /// <summary>Render every enabled camera (by depth) into an offscreen texture. Works in -batchmode; skips Screen Space - Overlay UI.</summary>
            Cameras,
            /// <summary>ScreenCapture.CaptureScreenshotAsTexture(): exactly what the window shows, overlay UI included. Needs a window (no -batchmode).</summary>
            Screen,
        }

        /// <summary>Edit in a [RuntimeInitializeOnLoadMethod] or an Awake: the hello is sent at the end of the first frame.</summary>
        public static readonly WitnessHello Hello = new WitnessHello { Language = "c#" };

        /// <summary>Optional: replaces the default snapshot ([WitnessEntity], [WitnessState], IWitnessState).</summary>
        public static Func<object> Snapshot;

        /// <summary>Optional: a synchronous reset (seed, scene, params). Default: reload the active scene (or load `scene`).</summary>
        public static Action<int, string, Dictionary<string, object>> Reset;

        /// <summary>Raised for each reset seed, before the scene reloads: seed your own System.Random etc. here.</summary>
        public static event Action<int> Seeded;

        /// <summary>Raised for "action" events (games with their own input-mapping layer).</summary>
        public static event Action<string, bool> ActionEvent;

        /// <summary>Optional: game-specific perf counters, merged into the perf reply.</summary>
        public static Func<object> Perf;

        public static ScreenshotSource Screenshots = ScreenshotSource.Cameras;

        /// <summary>Capture the mixed game audio with AudioRenderer (sample-exact, in step with simulated time).</summary>
        public static bool CaptureAudio = true;

        /// <summary>Old Input Manager projects: call WitnessInput.* instead of Input.*. True while Witness drives the game.</summary>
        public static bool Driving { get { return _instance != null && _mode == Mode.Witness && Witness.Connected; } }

        private enum Mode { Off, Witness, Recording }

        private static readonly Dictionary<string, Func<List<object>, object>> CallTable = new Dictionary<string, Func<List<object>, object>>();
        private static WitnessBridge _instance;
        private static Mode _mode;

        private WitnessHandlers _handlers;
        private bool _started;
        private bool _bootFrozen;
        private WitnessCommand _step;
        private double[] _dts;
        private int _stepIndex;
        private WitnessCommand _resetCmd;
        private bool _sceneLoaded;
        private int _resetWaits;
        private bool _audioRendering;
        private int _audioChannels;
        private readonly List<WitnessEvent> _recordEvents = new List<WitnessEvent>();

        /// <summary>Registers a custom command for `witness call name args`. Safe to call again after a scene reload.</summary>
        public static void RegisterCall(string name, string args, string help, Func<List<object>, object> fn)
        {
            if (!CallTable.ContainsKey(name)) Hello.Calls.Add(new WitnessCall(name, args, help));
            CallTable[name] = fn;
        }

        // ------------------------------------------------------------------ bootstrap

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()   // "Enter Play Mode" without a domain reload keeps statics alive
        {
            _instance = null;
            _mode = Mode.Off;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Bootstrap()
        {
            bool attach = false;
#if UNITY_EDITOR && WITNESS_ATTACH
            attach = true;   // Editor: with the WITNESS_ATTACH scripting define, Play mode connects to `witness attach`
#endif
            if (Witness.Active || attach) _mode = Mode.Witness;
            else if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WITNESS_RECORD"))) _mode = Mode.Recording;
            else return;   // inactive: nothing is created, hooked or allocated

            var go = new GameObject("Witness") { hideFlags = HideFlags.NotEditable };
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<WitnessBridge>();
            InstallPlayerLoop();
            if (_mode == Mode.Witness) _instance.EnterWitnessMode();
            else Witness.StartRecording(FillHello());
        }

        private void EnterWitnessMode()
        {
            Application.runInBackground = true;
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            Time.timeScale = 0f;   // the first frame (before the first reset/step) must not advance the game
            _bootFrozen = true;
            SetDt(1.0 / Math.Max(1, Hello.Fps));
#if UNITY_2022_2_OR_NEWER
            Physics.simulationMode = SimulationMode.Script;
#else
            Physics.autoSimulation = false;
#endif
            Physics2D.simulationMode = SimulationMode2D.Script;
            WitnessInput.Setup();
            Application.logMessageReceivedThreaded += OnUnityLog;
            SceneManager.sceneLoaded += OnSceneLoaded;
            if (CaptureAudio && SystemInfo.supportsAudio && AudioRenderer.Start())
            {
                _audioRendering = true;
                _audioChannels = SpeakerChannels(AudioSettings.speakerMode);
                Witness.Pcm = new WitnessPcm(AudioSettings.outputSampleRate, _audioChannels);
            }
            _handlers = new WitnessHandlers
            {
                Snapshot = TakeSnapshot,
                Screenshot = SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null ? null : (Func<double, WitnessImage>)TakeScreenshot,   // -nographics: no GPU
                Call = (name, args) =>
                {
                    Func<List<object>, object> fn;
                    if (!CallTable.TryGetValue(name, out fn)) throw new ArgumentException("unknown call '" + name + "'");
                    return fn(args);
                },
                Perf = () => Perf != null ? Perf() : new Dictionary<string, object>
                {
                    { "frame_ms", Time.unscaledDeltaTime * 1000.0 },
                    { "counts", new Dictionary<string, object> { { "objects", CountObjects() } } },
                },
                Quit = QuitGame,
            };
        }

        private static int CountObjects()
        {
#if UNITY_2023_1_OR_NEWER
            return FindObjectsByType<GameObject>(FindObjectsSortMode.None).Length;
#else
            return FindObjectsOfType<GameObject>().Length;
#endif
        }

        private static WitnessHello FillHello()
        {
            if (string.IsNullOrEmpty(Hello.Name) || Hello.Name == "game") Hello.Name = Application.productName;
            if (string.IsNullOrEmpty(Hello.Engine) || Hello.Engine == "custom") Hello.Engine = "Unity " + Application.unityVersion;
            if (Hello.Width <= 0 && Screen.width > 0)
            {
                Hello.Width = Screen.width;
                Hello.Height = Screen.height;
            }
            return Hello;
        }

        private void OnApplicationQuit()
        {
            if (_audioRendering) AudioRenderer.Stop();
            Witness.StopRecording();
        }

        // ------------------------------------------------------------------ PlayerLoop hooks

        private struct WitnessFrameStartHook { }
        private struct WitnessPhysicsHook { }
        private struct WitnessFrameEndHook { }

        private static void InstallPlayerLoop()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            Insert(ref loop, typeof(UnityEngine.PlayerLoop.EarlyUpdate), typeof(WitnessFrameStartHook), FrameStart, true);
            Insert(ref loop, typeof(UnityEngine.PlayerLoop.PreUpdate), typeof(WitnessPhysicsHook), PhysicsStep, true);
            Insert(ref loop, typeof(UnityEngine.PlayerLoop.PostLateUpdate), typeof(WitnessFrameEndHook), FrameEnd, false);
            PlayerLoop.SetPlayerLoop(loop);
        }

        private static void Insert(ref PlayerLoopSystem loop, Type phase, Type marker, PlayerLoopSystem.UpdateFunction fn, bool first)
        {
            for (int i = 0; i < loop.subSystemList.Length; i++)
            {
                if (loop.subSystemList[i].type != phase) continue;
                var subs = new List<PlayerLoopSystem>(loop.subSystemList[i].subSystemList ?? new PlayerLoopSystem[0]);
                subs.RemoveAll(s => s.type == marker);   // idempotent across Play-mode sessions without domain reload
                var sys = new PlayerLoopSystem { type = marker, updateDelegate = fn };
                if (first) subs.Insert(0, sys); else subs.Add(sys);
                loop.subSystemList[i].subSystemList = subs.ToArray();
                return;
            }
        }

        private static void FrameStart()
        {
            var b = _instance;
            if (b == null || _mode != Mode.Witness || b._step == null) return;
            WitnessInput.BeginFrame();
            foreach (var e in Witness.BeginFrame())
            {
                if (e.Type == "action")
                {
                    var handler = ActionEvent;
                    if (handler != null) handler(e.Action, e.IsDown);
                    continue;
                }
                WitnessInput.Apply(e, Hello.Width, Hello.Height);
            }
            WitnessInput.EndApply();
        }

        private static void PhysicsStep()
        {
            var b = _instance;
            if (b == null || _mode != Mode.Witness || b._step == null) return;
            float dt = Time.fixedDeltaTime;
            Physics.Simulate(dt);
            Physics2D.Simulate(dt);
        }

        private static void FrameEnd()
        {
            var b = _instance;
            if (b == null) return;
            if (_mode == Mode.Recording) { b.RecordFrame(); return; }
            if (_mode == Mode.Witness) b.WitnessFrameEnd();
        }

        private void WitnessFrameEnd()
        {
            if (!_started)
            {
                _started = true;
                if (!Witness.Connect(FillHello(), _handlers))
                {
                    Debug.LogError("[witness] could not connect to the Witness CLI at " + Witness.Address);
                    QuitGame();
                    return;
                }
                if (_handlers.Screenshot == null) Witness.Info("screenshots are off: no graphics device (-nographics)");
            }
            if (_step != null)
            {
                CaptureFrameAudio();
                Witness.EndFrame(_dts[_stepIndex]);
                if (++_stepIndex < _dts.Length)
                {
                    SetDt(_dts[_stepIndex]);
                    return;
                }
                var done = _step;
                _step = null;
                done.Reply(Witness.Clock());
            }
            if (_resetCmd != null && !FinishReset()) return;
            Serve();
        }

        // ------------------------------------------------------------------ session

        // Blocks the main thread and answers commands until one needs frames to run.
        private void Serve()
        {
            for (;;)
            {
                var cmd = Witness.Next();
                if (cmd == null) { QuitGame(); return; }   // the CLI went away
                switch (cmd.Name)
                {
                    case "step":
                        _dts = Witness.StepDts(cmd);
                        _stepIndex = 0;
                        _step = cmd;
                        if (_bootFrozen) { _bootFrozen = false; Time.timeScale = 1f; }   // stepping without a reset first
                        SetDt(_dts[0]);
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

        private static void SetDt(double dt)
        {
            float f = (float)dt;
            Time.captureDeltaTime = f;
            Time.fixedDeltaTime = f;
            if (Time.maximumDeltaTime < f) Time.maximumDeltaTime = f;
        }

        // Returns true when the reset needs a frame (scene load), false when it was answered.
        private bool BeginReset(WitnessCommand cmd)
        {
            int seed = (int)cmd.Long("seed", 1);
            string scene = cmd.String("scene");
            try
            {
                Witness.ResetClock(seed);
                UnityEngine.Random.InitState(seed);
                WitnessInput.ReleaseAll();
                _bootFrozen = false;
                var seeded = Seeded;
                if (seeded != null) seeded(seed);
                if (Reset != null)
                {
                    Reset(seed, scene, cmd.Object("params"));
                    Time.timeScale = 1f;
                    cmd.Reply();
                    return false;
                }
                _sceneLoaded = false;
                _resetWaits = 0;
                Time.timeScale = 0f;   // the load frame runs Awake/Start/Update with deltaTime 0
                SceneManager.LoadScene(string.IsNullOrEmpty(scene) ? SceneManager.GetActiveScene().name : scene, LoadSceneMode.Single);
            }
            catch (Exception e)
            {
                cmd.Fail(e.GetType().Name + ": " + e.Message);
                return false;
            }
            _resetCmd = cmd;
            return true;
        }

        private void OnSceneLoaded(Scene scene, LoadSceneMode mode) { _sceneLoaded = true; }

        private bool FinishReset()
        {
            if (!_sceneLoaded && ++_resetWaits < 10) return false;
            var cmd = _resetCmd;
            _resetCmd = null;
            Time.timeScale = 1f;
            if (_audioRendering && Witness.Pcm != null) Witness.Pcm.Clear();   // drop audio mixed during the load frame
            if (_sceneLoaded) cmd.Reply();
            else cmd.Fail("the scene didn't load within 10 frames (is it in the Build Settings scene list?)");
            return true;
        }

        private void QuitGame()
        {
#if UNITY_EDITOR
            UnityEditor.EditorApplication.ExitPlaymode();
#else
            Application.Quit();
#endif
        }

        // ------------------------------------------------------------------ audio

        private void CaptureFrameAudio()
        {
            if (!_audioRendering || Witness.Pcm == null) return;
            int frames = AudioRenderer.GetSampleCountForCaptureFrame();
            if (frames <= 0) return;
            var buffer = new NativeArray<float>(frames * _audioChannels, Allocator.Temp);
            try
            {
                if (AudioRenderer.Render(buffer)) Witness.Pcm.Write(buffer.ToArray());
            }
            finally
            {
                buffer.Dispose();
            }
        }

        private static int SpeakerChannels(AudioSpeakerMode mode)
        {
            switch (mode)
            {
                case AudioSpeakerMode.Mono: return 1;
                case AudioSpeakerMode.Quad: return 4;
                case AudioSpeakerMode.Surround: return 5;
                case AudioSpeakerMode.Mode5point1: return 6;
                case AudioSpeakerMode.Mode7point1: return 8;
                case AudioSpeakerMode.Prologic: return 2;
                default: return 2;
            }
        }

        // ------------------------------------------------------------------ logs

        private static void OnUnityLog(string message, string stack, LogType type)
        {
            string level = type == LogType.Warning ? "warn" : type == LogType.Log ? "info" : "error";
            if (type == LogType.Exception && !string.IsNullOrEmpty(stack))
            {
                int nl = stack.IndexOf('\n');
                message += " at " + (nl > 0 ? stack.Substring(0, nl) : stack);
            }
            Witness.Log(level, message);
        }

        // ------------------------------------------------------------------ screenshots

        private WitnessImage TakeScreenshot(double scale)
        {
            int w = Hello.Width > 0 ? Hello.Width : Screen.width, h = Hello.Height > 0 ? Hello.Height : Screen.height;
            Texture2D tex = null;
            RenderTexture rt = null;
            var previousActive = RenderTexture.active;
            try
            {
                if (Screenshots == ScreenshotSource.Screen)
                {
                    tex = ScreenCapture.CaptureScreenshotAsTexture();
                    if (tex == null) throw new InvalidOperationException("ScreenCapture returned nothing (no window? use WitnessBridge.Screenshots = Cameras under -batchmode)");
                }
                else
                {
                    var cameras = new List<Camera>(Camera.allCameras);
                    if (cameras.Count == 0) throw new InvalidOperationException("no enabled camera to render");
                    cameras.Sort((a, c) => a.depth.CompareTo(c.depth));
                    rt = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32);
                    RenderTexture.active = rt;
                    GL.Clear(true, true, Color.black);
                    foreach (var cam in cameras)
                    {
                        var target = cam.targetTexture;
                        cam.targetTexture = rt;
                        cam.Render();
                        cam.targetTexture = target;
                    }
                    RenderTexture.active = rt;
                    tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
                    tex.ReadPixels(new Rect(0, 0, w, h), 0, 0, false);
                    tex.Apply(false);
                }
                Color32[] px = tex.GetPixels32();   // bottom-up rows, any texture format
                int tw = tex.width, th = tex.height;
                var rgba = new byte[tw * th * 4];
                for (int y = 0; y < th; y++)
                {
                    int src = (th - 1 - y) * tw, dst = y * tw * 4;
                    for (int x = 0; x < tw; x++)
                    {
                        var c = px[src + x];
                        int i = dst + x * 4;
                        rgba[i] = c.r;
                        rgba[i + 1] = c.g;
                        rgba[i + 2] = c.b;
                        rgba[i + 3] = c.a;
                    }
                }
                return WitnessImage.FromRgba(tw, th, rgba);
            }
            finally
            {
                RenderTexture.active = previousActive;
                if (rt != null) RenderTexture.ReleaseTemporary(rt);
                if (tex != null) Destroy(tex);
            }
        }

        // ------------------------------------------------------------------ snapshots

        private sealed class MemberInfoCache
        {
            public WitnessEntityAttribute Entity;
            public readonly List<KeyValuePair<string, MemberInfo>> Members = new List<KeyValuePair<string, MemberInfo>>();
            public MemberInfo IdMember;
            public bool HasState;
            public bool Relevant { get { return Entity != null || Members.Count > 0 || HasState; } }
        }

        private static readonly Dictionary<Type, MemberInfoCache> TypeCache = new Dictionary<Type, MemberInfoCache>();

        private static MemberInfoCache Describe(Type t)
        {
            MemberInfoCache info;
            if (TypeCache.TryGetValue(t, out info)) return info;
            info = new MemberInfoCache
            {
                Entity = (WitnessEntityAttribute)Attribute.GetCustomAttribute(t, typeof(WitnessEntityAttribute), true),
                HasState = typeof(IWitnessState).IsAssignableFrom(t),
            };
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var m in t.GetMembers(flags))
            {
                if (!(m is FieldInfo) && !(m is PropertyInfo)) continue;
                var attr = (WitnessStateAttribute)Attribute.GetCustomAttribute(m, typeof(WitnessStateAttribute), true);
                if (attr == null) continue;
                string key = attr.Name ?? m.Name;
                info.Members.Add(new KeyValuePair<string, MemberInfo>(key, m));
                if (key == "id" || key == "Id") info.IdMember = m;
            }
            info.Members.Sort((a, c) => string.CompareOrdinal(a.Key, c.Key));
            TypeCache[t] = info;
            return info;
        }

        private static object Read(MemberInfo m, object target)
        {
            var f = m as FieldInfo;
            object v = f != null ? f.GetValue(target) : ((PropertyInfo)m).GetValue(target, null);
            var uo = v as UnityEngine.Object;
            if (uo != null) return uo.name;   // references become names, never a reflection walk
            if (v is UnityEngine.Object) return null;   // destroyed object
            return v;
        }

        private object TakeSnapshot()
        {
            if (Snapshot != null) return Snapshot();
            var state = new Dictionary<string, object>();
            var entities = new List<object>();
            state["scene"] = SceneManager.GetActiveScene().name;
            var roots = new List<GameObject>();
            for (int s = 0; s < SceneManager.sceneCount; s++)
            {
                var sc = SceneManager.GetSceneAt(s);
                if (sc.isLoaded) roots.AddRange(sc.GetRootGameObjects());
            }
            roots.AddRange(gameObject.scene.GetRootGameObjects());   // DontDestroyOnLoad objects
            var path = new List<string>();
            foreach (var root in roots)
            {
                if (!root.activeInHierarchy) continue;
                foreach (var mb in root.GetComponentsInChildren<MonoBehaviour>(false))   // hierarchy order: stable across runs
                {
                    if (mb == null || !mb.enabled) continue;
                    var info = Describe(mb.GetType());
                    if (!info.Relevant) continue;
                    Dictionary<string, object> target;
                    if (info.Entity != null)
                    {
                        var p = mb.transform.position;
                        target = new Dictionary<string, object>
                        {
                            { "id", info.IdMember != null ? Read(info.IdMember, mb) : HierarchyPath(mb.transform, path) },
                            { "type", info.Entity.Type ?? mb.GetType().Name },
                            { "pos", info.Entity.Is2D ? new[] { p.x, p.y } : new[] { p.x, p.y, p.z } },
                        };
                        entities.Add(target);
                    }
                    else if (info.Members.Count > 0)
                    {
                        target = new Dictionary<string, object>();
                        state[mb.GetType().Name] = target;
                    }
                    else target = state;
                    foreach (var kv in info.Members) target[kv.Key] = Read(kv.Value, mb);
                    var computed = info.HasState ? ((IWitnessState)mb).WitnessState() as IDictionary : null;
                    if (computed != null) foreach (DictionaryEntry kv in computed) target[Convert.ToString(kv.Key)] = kv.Value;
                }
            }
            state["entities"] = entities;
            return state;
        }

        private static string HierarchyPath(Transform t, List<string> scratch)
        {
            scratch.Clear();
            for (var x = t; x != null; x = x.parent) scratch.Add(x.name + "#" + x.GetSiblingIndex());
            scratch.Reverse();
            return string.Join("/", scratch.ToArray());
        }

        // ------------------------------------------------------------------ recording (normal play)

        private void RecordFrame()
        {
            _recordEvents.Clear();
#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            var kb = UnityEngine.InputSystem.Keyboard.current;
            if (kb != null)
            {
                foreach (var key in kb.allKeys)
                {
                    if (key == null) continue;
                    bool down = key.wasPressedThisFrame, up = key.wasReleasedThisFrame;
                    if (!down && !up) continue;
                    if (down && key.keyCode == UnityEngine.InputSystem.Key.F8) { Witness.Mark("F8"); continue; }
                    _recordEvents.Add(WitnessEvent.KeyEvent(WitnessKeys.Normalize(key.keyCode.ToString()), down));
                }
            }
#elif ENABLE_LEGACY_INPUT_MANAGER
            if (Input.anyKeyDown || _legacyHeld.Count > 0)
            {
                foreach (KeyCode key in LegacyKeys)
                {
                    if (Input.GetKeyDown(key))
                    {
                        if (key == KeyCode.F8) { Witness.Mark("F8"); continue; }
                        _legacyHeld.Add(key);
                        _recordEvents.Add(WitnessEvent.KeyEvent(WitnessKeys.Normalize(key.ToString()), true));
                    }
                    else if (Input.GetKeyUp(key) && _legacyHeld.Remove(key))
                    {
                        _recordEvents.Add(WitnessEvent.KeyEvent(WitnessKeys.Normalize(key.ToString()), false));
                    }
                }
            }
#endif
            Witness.RecordFrame(Time.unscaledDeltaTime, _recordEvents);
        }

#if !(WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM) && ENABLE_LEGACY_INPUT_MANAGER
        private readonly HashSet<KeyCode> _legacyHeld = new HashSet<KeyCode>();
        private static readonly KeyCode[] LegacyKeys = BuildLegacyKeys();

        private static KeyCode[] BuildLegacyKeys()
        {
            var keys = new List<KeyCode>();
            foreach (KeyCode k in Enum.GetValues(typeof(KeyCode))) if (k > KeyCode.None && k < KeyCode.Mouse0 && !keys.Contains(k)) keys.Add(k);
            return keys.ToArray();
        }
#endif
    }
}
