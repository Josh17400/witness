// Input for Witness on Unity.
//
// New Input System (com.unity.inputsystem): nothing to change in game code. In witness mode events are
// queued as real device state (InputSystem.QueueStateEvent) on virtual Keyboard/Mouse/Gamepad devices and
// processed with a manual InputSystem.Update() at the start of each frame, so actions, PlayerInput and
// Keyboard.current all see them. Touch events go to a virtual Touchscreen (added on the first touch event,
// so games that check Touchscreen.current see no touchscreen until a test touches).
//
// Old Input Manager: UnityEngine.Input can't be fed from code, so call WitnessInput instead of Input
// (same names: GetKey, GetKeyDown, GetAxisRaw, GetButton, mousePosition, touchCount, GetTouch, ...).
// Outside witness mode every call forwards to UnityEngine.Input, so the swap is free.
//
// Touch mouse fallback: unless WitnessBridge.Hello.Touch is set, finger 0 also arrives as mouse events
// (Witness.cs synthesizes them, flagged FromTouch), like Unity's Input.simulateMouseWithTouches.
using System.Collections.Generic;
using UnityEngine;
#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
#endif

namespace WitnessKit
{
    public static class WitnessInput
    {
        private static readonly HashSet<KeyCode> Held = new HashSet<KeyCode>();
        private static readonly HashSet<KeyCode> Pressed = new HashSet<KeyCode>();
        private static readonly HashSet<KeyCode> Released = new HashSet<KeyCode>();
        private static readonly Dictionary<string, float> Axes = new Dictionary<string, float>();
        private static Vector2 _mouse;
        private static Vector2 _scroll;
        private static string _text = "";

        // Fingers down (or lifted this frame), in the order they went down: what touchCount/GetTouch report.
        private sealed class Finger
        {
            public int Id;
            public Vector2 Position;
            public Vector2 Delta;
            public float Pressure;
            public UnityEngine.TouchPhase Phase;
        }

        private static readonly List<Finger> Fingers = new List<Finger>();

        /// <summary>True while Witness drives the game (input comes from the CLI, not devices).</summary>
        public static bool Driving { get { return WitnessBridge.Driving; } }

        // ---------------------------------------------------------- Input-compatible API

        public static bool GetKey(KeyCode key)
        {
            if (Driving) return Held.Contains(key);
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetKey(key);
#else
            return false;
#endif
        }

        public static bool GetKeyDown(KeyCode key)
        {
            if (Driving) return Pressed.Contains(key);
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetKeyDown(key);
#else
            return false;
#endif
        }

        public static bool GetKeyUp(KeyCode key)
        {
            if (Driving) return Released.Contains(key);
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetKeyUp(key);
#else
            return false;
#endif
        }

        public static bool GetMouseButton(int button) { return GetKey(KeyCode.Mouse0 + button); }
        public static bool GetMouseButtonDown(int button) { return GetKeyDown(KeyCode.Mouse0 + button); }
        public static bool GetMouseButtonUp(int button) { return GetKeyUp(KeyCode.Mouse0 + button); }

        /// <summary>Screen pixels, bottom-left origin (like Input.mousePosition).</summary>
        public static Vector3 mousePosition
        {
            get
            {
                if (Driving) return _mouse;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.mousePosition;
#else
                return Vector3.zero;
#endif
            }
        }

        public static Vector2 mouseScrollDelta
        {
            get
            {
                if (Driving) return _scroll;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.mouseScrollDelta;
#else
                return Vector2.zero;
#endif
            }
        }

        public static string inputString
        {
            get
            {
                if (Driving) return _text;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.inputString;
#else
                return "";
#endif
            }
        }

        public static bool anyKey
        {
            get
            {
                if (Driving) return Held.Count > 0;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.anyKey;
#else
                return false;
#endif
            }
        }

        public static bool anyKeyDown
        {
            get
            {
                if (Driving) return Pressed.Count > 0;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.anyKeyDown;
#else
                return false;
#endif
            }
        }

        /// <summary>
        /// The default Input Manager axes: Horizontal/Vertical (arrows, WASD, left stick), Mouse ScrollWheel,
        /// and any gamepad axis by Witness name ("leftx", "righttrigger"). No smoothing in witness mode.
        /// </summary>
        public static float GetAxisRaw(string axis)
        {
            if (!Driving)
            {
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.GetAxisRaw(axis);
#else
                return 0f;
#endif
            }
            float v;
            switch (axis)
            {
                case "Horizontal":
                    v = (Held.Contains(KeyCode.RightArrow) || Held.Contains(KeyCode.D) ? 1f : 0f) - (Held.Contains(KeyCode.LeftArrow) || Held.Contains(KeyCode.A) ? 1f : 0f);
                    return v != 0f ? v : AxisValue("leftx");
                case "Vertical":
                    v = (Held.Contains(KeyCode.UpArrow) || Held.Contains(KeyCode.W) ? 1f : 0f) - (Held.Contains(KeyCode.DownArrow) || Held.Contains(KeyCode.S) ? 1f : 0f);
                    return v != 0f ? v : -AxisValue("lefty");
                case "Mouse ScrollWheel":
                    return _scroll.y;
                default:
                    return AxisValue(axis);
            }
        }

        public static float GetAxis(string axis)
        {
            if (Driving) return GetAxisRaw(axis);
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetAxis(axis);
#else
            return 0f;
#endif
        }

        /// <summary>Fingers on the screen this frame (like Input.touchCount).</summary>
        public static int touchCount
        {
            get
            {
                if (Driving) return Fingers.Count;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.touchCount;
#else
                return 0;
#endif
            }
        }

        /// <summary>
        /// Like Input.GetTouch: fingerId = the Witness finger id, position in screen pixels (bottom-left origin),
        /// phase Began / Moved / Stationary / Ended for this frame.
        /// </summary>
        public static UnityEngine.Touch GetTouch(int index)
        {
            if (Driving)
            {
                var f = Fingers[index];
                var t = new UnityEngine.Touch();
                t.fingerId = f.Id;
                t.position = f.Position;
                t.rawPosition = f.Position;
                t.deltaPosition = f.Delta;
                t.deltaTime = Time.deltaTime;
                t.phase = f.Phase;
                t.pressure = f.Pressure;
                t.maximumPossiblePressure = 1f;
                t.tapCount = 1;
                t.type = UnityEngine.TouchType.Direct;
                return t;
            }
#if ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetTouch(index);
#else
            throw new System.ArgumentOutOfRangeException("index", "no touches without the legacy Input Manager");
#endif
        }

        /// <summary>All fingers this frame (like Input.touches).</summary>
        public static UnityEngine.Touch[] touches
        {
            get
            {
                if (!Driving)
                {
#if ENABLE_LEGACY_INPUT_MANAGER
                    return Input.touches;
#else
                    return new UnityEngine.Touch[0];
#endif
                }
                var o = new UnityEngine.Touch[Fingers.Count];
                for (int i = 0; i < o.Length; i++) o[i] = GetTouch(i);
                return o;
            }
        }

        public static bool touchSupported
        {
            get
            {
                if (Driving) return true;
#if ENABLE_LEGACY_INPUT_MANAGER
                return Input.touchSupported;
#else
                return false;
#endif
            }
        }

        /// <summary>The default Input Manager buttons: Jump, Fire1-3, Submit, Cancel.</summary>
        public static bool GetButton(string button) { return Driving ? AnyOf(Held, button) : LegacyButton(button, 0); }
        public static bool GetButtonDown(string button) { return Driving ? AnyOf(Pressed, button) : LegacyButton(button, 1); }
        public static bool GetButtonUp(string button) { return Driving ? AnyOf(Released, button) : LegacyButton(button, 2); }

        // ---------------------------------------------------------- driven by WitnessBridge

        internal static void BeginFrame()
        {
            Pressed.Clear();
            Released.Clear();
            _scroll = Vector2.zero;
            _text = "";
            Fingers.RemoveAll(x => x.Phase == UnityEngine.TouchPhase.Ended || x.Phase == UnityEngine.TouchPhase.Canceled);
            foreach (var f in Fingers)
            {
                f.Phase = UnityEngine.TouchPhase.Stationary;
                f.Delta = Vector2.zero;
            }
        }

        internal static void ReleaseAll()
        {
            foreach (var k in Held) Released.Add(k);
            Held.Clear();
            Axes.Clear();
            Fingers.Clear();
#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            DeviceInput.ReleaseAll();
#endif
        }

        /// <summary>Applies one Witness event (screen size is used to flip mouse/touch y to Unity's bottom-left origin).</summary>
        internal static void Apply(WitnessEvent e, float logicalWidth, float logicalHeight)
        {
            float sx = logicalWidth > 0 ? Screen.width / logicalWidth : 1f, sy = logicalHeight > 0 ? Screen.height / logicalHeight : 1f;
            Vector2 touchPos = Vector2.zero;
            switch (e.Type)
            {
                case "key":
                {
                    KeyCode key;
                    if (WitnessKeys.TryParse(e.Key, out key)) SetKey(key, e.IsDown);
                    else Witness.Warn("unknown key '" + e.Key + "' for UnityEngine.KeyCode");
                    break;
                }
                case "mouse":
                    _mouse = new Vector2((float)e.X * sx, Screen.height - (float)e.Y * sy);
                    if (e.Down.HasValue) SetKey(KeyCode.Mouse0 + Mathf.Clamp(e.Button, 0, 6), e.IsDown);
                    break;
                case "wheel":
                    _scroll += new Vector2((float)e.Dx, (float)-e.Dy) / 100f;   // Witness +dy = scroll down
                    break;
                case "text":
                    _text += e.Text ?? "";
                    break;
                case "axis":
                    Axes[e.Axis ?? ""] = (float)e.Value;
                    break;
                case "pad":
                {
                    KeyCode button;
                    if (PadToKeyCode.TryGetValue(e.PadButton ?? "", out button)) SetKey(button, e.IsDown);
                    break;
                }
                case "touch":
                    touchPos = new Vector2((float)e.X * sx, Screen.height - (float)e.Y * sy);
                    ApplyFinger(e, touchPos);
                    break;
            }
#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            DeviceInput.Apply(e, _mouse, touchPos);
#endif
        }

        // Legacy-style touch state: Began on the frame a finger goes down, Moved when it moves, Ended on lift.
        private static void ApplyFinger(WitnessEvent e, Vector2 pos)
        {
            Finger f = Fingers.Find(x => x.Id == e.Id && x.Phase != UnityEngine.TouchPhase.Ended);
            if (e.Phase == WitnessTouchPhase.Down)
            {
                if (f == null) { f = new Finger { Id = e.Id }; Fingers.Add(f); }
                f.Position = pos;
                f.Delta = Vector2.zero;
                f.Pressure = (float)e.Pressure;
                f.Phase = UnityEngine.TouchPhase.Began;
                return;
            }
            if (f == null) return;   // a move or lift without a down
            f.Delta += pos - f.Position;
            f.Position = pos;
            f.Pressure = (float)e.Pressure;
            if (e.Phase == WitnessTouchPhase.Up) f.Phase = UnityEngine.TouchPhase.Ended;
            else if (f.Phase != UnityEngine.TouchPhase.Began) f.Phase = UnityEngine.TouchPhase.Moved;
        }

        /// <summary>Called after a frame's events: pushes the device state to the Input System.</summary>
        internal static void EndApply()
        {
#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            DeviceInput.Flush();
#endif
        }

        internal static void Setup()
        {
#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
            DeviceInput.Setup();
#endif
        }

        private static void SetKey(KeyCode key, bool down)
        {
            if (down) { if (Held.Add(key)) Pressed.Add(key); }
            else if (Held.Remove(key)) Released.Add(key);
        }

        private static float AxisValue(string name)
        {
            float v;
            return Axes.TryGetValue(name, out v) ? v : 0f;
        }

        private static readonly Dictionary<string, KeyCode[]> Buttons = new Dictionary<string, KeyCode[]>
        {
            { "Jump", new[] { KeyCode.Space, KeyCode.JoystickButton3 } },
            { "Fire1", new[] { KeyCode.LeftControl, KeyCode.Mouse0, KeyCode.JoystickButton0 } },
            { "Fire2", new[] { KeyCode.LeftAlt, KeyCode.Mouse1, KeyCode.JoystickButton1 } },
            { "Fire3", new[] { KeyCode.LeftShift, KeyCode.Mouse2, KeyCode.JoystickButton2 } },
            { "Submit", new[] { KeyCode.Return, KeyCode.KeypadEnter, KeyCode.Space, KeyCode.JoystickButton0 } },
            { "Cancel", new[] { KeyCode.Escape, KeyCode.JoystickButton1 } },
        };

        private static readonly Dictionary<string, KeyCode> PadToKeyCode = new Dictionary<string, KeyCode>(System.StringComparer.OrdinalIgnoreCase)
        {
            { "a", KeyCode.JoystickButton0 }, { "b", KeyCode.JoystickButton1 }, { "x", KeyCode.JoystickButton2 }, { "y", KeyCode.JoystickButton3 },
            { "leftshoulder", KeyCode.JoystickButton4 }, { "rightshoulder", KeyCode.JoystickButton5 },
            { "back", KeyCode.JoystickButton6 }, { "start", KeyCode.JoystickButton7 },
            { "leftstick", KeyCode.JoystickButton8 }, { "rightstick", KeyCode.JoystickButton9 },
        };

        private static bool AnyOf(HashSet<KeyCode> set, string button)
        {
            KeyCode[] keys;
            if (!Buttons.TryGetValue(button, out keys)) return false;
            foreach (var k in keys) if (set.Contains(k)) return true;
            return false;
        }

        private static bool LegacyButton(string button, int kind)
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            return kind == 0 ? Input.GetButton(button) : kind == 1 ? Input.GetButtonDown(button) : Input.GetButtonUp(button);
#else
            return false;
#endif
        }

#if WITNESS_INPUT_SYSTEM && ENABLE_INPUT_SYSTEM
        // Virtual devices fed with state events; processed by InputSystem.Update() once per frame.
        private static class DeviceInput
        {
            private static readonly HashSet<Key> Keys = new HashSet<Key>();
            private static Keyboard _keyboard;
            private static Mouse _mouseDevice;
            private static Gamepad _gamepad;
            private static MouseState _mouseState;
            private static GamepadState _padState;
            private static bool _keysDirty, _mouseDirty, _padDirty;
            private static Touchscreen _touchscreen;
            private static readonly Dictionary<int, Vector2> TouchPositions = new Dictionary<int, Vector2>();   // Witness finger id -> last position

            public static void Setup()
            {
                InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsManually;
                InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
                _keyboard = Keyboard.current ?? InputSystem.AddDevice<Keyboard>();
                _mouseDevice = Mouse.current ?? InputSystem.AddDevice<Mouse>();
                _gamepad = Gamepad.current ?? InputSystem.AddDevice<Gamepad>();
            }

            public static void Apply(WitnessEvent e, Vector2 mouse, Vector2 touchPos)
            {
                switch (e.Type)
                {
                    case "touch":
                    {
                        // One TouchState event per finger change; the Touchscreen assigns it a touch control.
                        // touchId 0 means "no touch" to the Input System, so Witness finger n is touchId n + 1.
                        Vector2 last;
                        bool known = TouchPositions.TryGetValue(e.Id, out last);
                        if (e.Phase != WitnessTouchPhase.Down && !known) return;   // a move or lift without a down
                        if (_touchscreen == null) _touchscreen = Touchscreen.current ?? InputSystem.AddDevice<Touchscreen>();
                        var phase = e.Phase == WitnessTouchPhase.Down ? UnityEngine.InputSystem.TouchPhase.Began
                            : e.Phase == WitnessTouchPhase.Up ? UnityEngine.InputSystem.TouchPhase.Ended : UnityEngine.InputSystem.TouchPhase.Moved;
                        InputSystem.QueueStateEvent(_touchscreen, new TouchState
                        {
                            touchId = e.Id + 1,
                            phase = phase,
                            position = touchPos,
                            delta = known && e.Phase != WitnessTouchPhase.Down ? touchPos - last : Vector2.zero,
                            pressure = (float)e.Pressure,
                        });
                        if (e.Phase == WitnessTouchPhase.Up) TouchPositions.Remove(e.Id);
                        else TouchPositions[e.Id] = touchPos;
                        break;
                    }
                    case "key":
                    {
                        Key key;
                        if (!WitnessKeys.TryParse(e.Key, out key)) return;
                        if (e.IsDown) Keys.Add(key); else Keys.Remove(key);
                        _keysDirty = true;
                        break;
                    }
                    case "mouse":
                        _mouseState.delta = mouse - _mouseState.position;
                        _mouseState.position = mouse;
                        if (e.Down.HasValue) _mouseState = _mouseState.WithButton(e.Button == 1 ? MouseButton.Middle : e.Button == 2 ? MouseButton.Right : MouseButton.Left, e.IsDown);
                        _mouseDirty = true;
                        break;
                    case "wheel":
                        _mouseState.scroll += new Vector2((float)e.Dx, (float)-e.Dy);
                        _mouseDirty = true;
                        break;
                    case "text":
                        foreach (char c in e.Text ?? "") InputSystem.QueueTextEvent(_keyboard, c);
                        break;
                    case "pad":
                    {
                        GamepadButton b;
                        if (!PadButtons.TryGetValue(e.PadButton ?? "", out b)) return;
                        _padState = _padState.WithButton(b, e.IsDown);
                        _padDirty = true;
                        break;
                    }
                    case "axis":
                    {
                        float v = (float)e.Value;
                        switch ((e.Axis ?? "").ToLowerInvariant())
                        {
                            case "leftx": _padState.leftStick.x = v; break;
                            case "lefty": _padState.leftStick.y = -v; break;    // Witness/SDL: +y is down
                            case "rightx": _padState.rightStick.x = v; break;
                            case "righty": _padState.rightStick.y = -v; break;
                            case "lefttrigger": _padState.leftTrigger = v; break;
                            case "righttrigger": _padState.rightTrigger = v; break;
                            default: return;
                        }
                        _padDirty = true;
                        break;
                    }
                }
            }

            public static void Flush()
            {
                if (_keysDirty) InputSystem.QueueStateEvent(_keyboard, new KeyboardState(new List<Key>(Keys).ToArray()));
                if (_mouseDirty) InputSystem.QueueStateEvent(_mouseDevice, _mouseState);
                if (_padDirty) InputSystem.QueueStateEvent(_gamepad, _padState);
                _keysDirty = _mouseDirty = _padDirty = false;
                InputSystem.Update();
                if (_mouseState.scroll != Vector2.zero || _mouseState.delta != Vector2.zero)
                {
                    _mouseState.scroll = Vector2.zero;   // scroll and delta are per-frame
                    _mouseState.delta = Vector2.zero;
                    _mouseDirty = true;
                }
            }

            public static void ReleaseAll()
            {
                if (_touchscreen != null)
                {
                    foreach (var kv in TouchPositions)
                        InputSystem.QueueStateEvent(_touchscreen, new TouchState { touchId = kv.Key + 1, phase = UnityEngine.InputSystem.TouchPhase.Ended, position = kv.Value });
                }
                TouchPositions.Clear();
                Keys.Clear();
                _mouseState = new MouseState { position = _mouseState.position };
                _padState = new GamepadState();
                _keysDirty = _mouseDirty = _padDirty = true;
                if (_keyboard != null) Flush();
            }

            private static readonly Dictionary<string, GamepadButton> PadButtons = new Dictionary<string, GamepadButton>(System.StringComparer.OrdinalIgnoreCase)
            {
                { "a", GamepadButton.South }, { "b", GamepadButton.East }, { "x", GamepadButton.West }, { "y", GamepadButton.North },
                { "back", GamepadButton.Select }, { "start", GamepadButton.Start },
                { "leftstick", GamepadButton.LeftStick }, { "rightstick", GamepadButton.RightStick },
                { "leftshoulder", GamepadButton.LeftShoulder }, { "rightshoulder", GamepadButton.RightShoulder },
                { "dpup", GamepadButton.DpadUp }, { "dpdown", GamepadButton.DpadDown }, { "dpleft", GamepadButton.DpadLeft }, { "dpright", GamepadButton.DpadRight },
            };
        }
#endif
    }
}
