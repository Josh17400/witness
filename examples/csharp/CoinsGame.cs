// The standard Witness sample game ("coins", docs/ADAPTERS.md). Pure simulation: no clock, no
// console, no window. Everything advances only through Step(dt), so the same seed and inputs
// always give the same state.
using System;
using System.Collections.Generic;
using WitnessKit;

namespace Coins
{
    public sealed class Entity
    {
        public int Id;
        public string Type;
        public double X;
        public double Y;
        public int Hp;

        public Dictionary<string, object> ToJson()
        {
            var o = new Dictionary<string, object> { { "id", Id }, { "type", Type }, { "pos", new[] { X, Y } } };
            if (Hp > 0) o["hp"] = Hp;
            return o;
        }
    }

    public sealed class CoinsGame
    {
        public const int Width = 320, Height = 180, Fps = 60, SampleRate = 22050;
        private const double Speed = 120, PickupRadius = 12;

        private static readonly float[] Ding = MakeDing();
        private readonly HashSet<string> _held = new HashSet<string>();
        private readonly List<Entity> _coins = new List<Entity>();
        private Entity _player;
        private int _score;

        public CoinsGame() { Reset(1); }

        public void Reset(int seed)
        {
            _held.Clear();
            _coins.Clear();
            _score = 0;
            _player = new Entity { Id = 1, Type = "Player", X = 40, Y = 90, Hp = 3 };
            for (int i = 0; i < 5; i++)
                _coins.Add(new Entity { Id = 10 + i, Type = "Coin", X = 80 + i * 40, Y = i == 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61) });
        }

        /// <summary>Input arrives through the same path in witness mode and in real-time play.</summary>
        public void Apply(WitnessEvent e)
        {
            if (e.Type == "key" && e.Key != null)
            {
                if (e.IsDown) _held.Add(e.Key);
                else if (e.IsUp) _held.Remove(e.Key);
            }
            else if (e.Type == "action" && e.Action == "dash" && e.IsDown)
            {
                _player.X += 30;
            }
        }

        public void Step(double dt)
        {
            int dx = (Held("right", "d") ? 1 : 0) - (Held("left", "a") ? 1 : 0);
            int dy = (Held("down", "s") ? 1 : 0) - (Held("up", "w") ? 1 : 0);
            _player.X = Math.Max(0, Math.Min(Width, _player.X + dx * Speed * dt));
            _player.Y = Math.Max(0, Math.Min(Height, _player.Y + dy * Speed * dt));
            foreach (var c in _coins.ToArray())
            {
                double ddx = c.X - _player.X, ddy = c.Y - _player.Y;
                if (Math.Sqrt(ddx * ddx + ddy * ddy) >= PickupRadius) continue;
                _coins.Remove(c);
                _score++;
                Witness.Info("coin " + c.Id + " collected");
                if (Witness.Pcm != null) Witness.Pcm.Play(Ding);
            }
        }

        public object Snapshot()
        {
            var entities = new List<object> { _player.ToJson() };
            foreach (var c in _coins) entities.Add(c.ToJson());
            return new Dictionary<string, object>
            {
                { "score", _score }, { "scene", "level1" }, { "player", _player.ToJson() }, { "entities", entities },
            };
        }

        public object Call(string name, List<object> args)
        {
            switch (name)
            {
                case "teleport":
                    _player.X = Arg(args, 0);
                    _player.Y = Arg(args, 1);
                    return new[] { _player.X, _player.Y };
                case "addcoin":
                    _coins.Add(new Entity { Id = 100 + _coins.Count, Type = "Coin", X = Arg(args, 0), Y = Arg(args, 1) });
                    return _coins.Count;
                default:
                    throw new ArgumentException("unknown call '" + name + "' (try teleport x y, addcoin x y)");
            }
        }

        public int Score { get { return _score; } }
        public int CoinsLeft { get { return _coins.Count; } }
        public Entity Player { get { return _player; } }
        public IReadOnlyList<Entity> CoinList { get { return _coins; } }

        /// <summary>320×180 RGBA, top-down: dark background, yellow coins, blue player.</summary>
        public WitnessImage Render()
        {
            var px = new byte[Width * Height * 4];
            for (int i = 0; i < Width * Height; i++) Put(px, i, 20, 24, 40);
            foreach (var c in _coins) Blob(px, c.X, c.Y, 5, 255, 210, 60);
            Blob(px, _player.X, _player.Y, 7, 80, 200, 255);
            return WitnessImage.FromRgba(Width, Height, px);
        }

        private bool Held(string a, string b) { return _held.Contains(a) || _held.Contains(b); }

        private static double Arg(List<object> args, int i)
        {
            if (args == null || i >= args.Count) throw new ArgumentException("expected 2 numbers: x y");
            double v = WitnessJson.Double(args[i], double.NaN);
            if (double.IsNaN(v)) throw new ArgumentException("'" + args[i] + "' is not a number");
            return v;
        }

        private static void Blob(byte[] px, double cx, double cy, int r, byte red, byte green, byte blue)
        {
            int ox = (int)Math.Floor(cx + 0.5), oy = (int)Math.Floor(cy + 0.5);   // JS Math.round semantics
            for (int y = -r; y <= r; y++)
                for (int x = -r; x <= r; x++)
                {
                    if (x * x + y * y > r * r) continue;
                    int tx = ox + x, ty = oy + y;
                    if (tx < 0 || ty < 0 || tx >= Width || ty >= Height) continue;
                    Put(px, ty * Width + tx, red, green, blue);
                }
        }

        private static void Put(byte[] px, int pixel, byte r, byte g, byte b)
        {
            int i = pixel * 4;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
            px[i + 3] = 255;
        }

        // A 0.15 s 880 Hz sine with a fast exponential decay.
        private static float[] MakeDing()
        {
            int n = (int)(SampleRate * 0.15);
            var s = new float[n];
            for (int i = 0; i < n; i++) s[i] = (float)(Math.Sin(2 * Math.PI * 880 * i / SampleRate) * 0.5 * Math.Exp(-i / (SampleRate * 0.04)));
            return s;
        }
    }
}
