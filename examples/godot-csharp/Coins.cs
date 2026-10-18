// The standard Witness sample game ("coins", docs/ADAPTERS.md) as an ordinary Godot scene script.
// Nothing here knows about witness mode except the snapshot (IWitnessState), two custom calls and
// the Witness.Pcm line next to the sound: input, timing, logging and resets go through Godot itself.
using System;
using System.Collections.Generic;
using Godot;
using WitnessKit;

public partial class Coins : Node2D, IWitnessState
{
    private const int SampleRate = 22050;
    private const float Speed = 120, PickupRadius = 12;

    private sealed class Entity
    {
        public int Id;
        public string Type;
        public double X, Y;

        public Dictionary<string, object> ToJson()
        {
            var o = new Dictionary<string, object> { { "id", Id }, { "type", Type }, { "pos", new[] { X, Y } } };
            if (Type == "Player") o["hp"] = 3;
            return o;
        }
    }

    private readonly List<Entity> _coins = new List<Entity>();
    private Entity _player;
    private int _score;
    private AudioStreamPlayer _sfx;
    private AudioStreamWav _ding;

    public override void _Ready()
    {
        int seed = Witness.Seed;   // the reset seed in witness mode
        _player = new Entity { Id = 1, Type = "Player", X = 40, Y = 90 };
        for (int i = 0; i < 5; i++)
            _coins.Add(new Entity { Id = 10 + i, Type = "Coin", X = 80 + i * 40, Y = i == 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61) });

        _ding = MakeDing();
        _sfx = new AudioStreamPlayer { Stream = _ding };
        AddChild(_sfx);
        if (Witness.Active && Witness.Pcm == null) Witness.Pcm = new WitnessPcm(SampleRate, 1);

        WitnessNode.RegisterCall("teleport", "x y", "move the player", args =>
        {
            _player.X = Arg(args, 0);
            _player.Y = Arg(args, 1);
            QueueRedraw();
            return new[] { _player.X, _player.Y };
        });
        WitnessNode.RegisterCall("addcoin", "x y", "add a coin, returns the coin count", args =>
        {
            _coins.Add(new Entity { Id = 100 + _coins.Count, Type = "Coin", X = Arg(args, 0), Y = Arg(args, 1) });
            QueueRedraw();
            return _coins.Count;
        });
    }

    public override void _PhysicsProcess(double delta)
    {
        int dx = (Held(Key.Right, Key.D) ? 1 : 0) - (Held(Key.Left, Key.A) ? 1 : 0);
        int dy = (Held(Key.Down, Key.S) ? 1 : 0) - (Held(Key.Up, Key.W) ? 1 : 0);
        _player.X = Math.Max(0, Math.Min(320, _player.X + dx * Speed * delta));
        _player.Y = Math.Max(0, Math.Min(180, _player.Y + dy * Speed * delta));
        foreach (var c in _coins.ToArray())
        {
            double ddx = c.X - _player.X, ddy = c.Y - _player.Y;
            if (Math.Sqrt(ddx * ddx + ddy * ddy) >= PickupRadius) continue;
            _coins.Remove(c);
            _score++;
            GD.Print("coin " + c.Id + " collected");   // reaches the Witness CLI through Godot's logger
            _sfx.Play();
            WitnessNode.Mix(_ding);                       // and the same sound into the capture buffer
        }
        QueueRedraw();
    }

    public override void _Draw()
    {
        DrawRect(new Rect2(0, 0, 320, 180), Color.Color8(20, 24, 40));
        foreach (var c in _coins) DrawCircle(new Vector2((float)c.X, (float)c.Y), 5, Color.Color8(255, 210, 60));
        DrawCircle(new Vector2((float)_player.X, (float)_player.Y), 7, Color.Color8(80, 200, 255));
    }

    public object WitnessState()
    {
        var entities = new List<object> { _player.ToJson() };
        foreach (var c in _coins) entities.Add(c.ToJson());
        return new Dictionary<string, object> { { "score", _score }, { "scene", "level1" }, { "player", _player.ToJson() }, { "entities", entities } };
    }

    private static bool Held(Key a, Key b) { return Input.IsKeyPressed(a) || Input.IsKeyPressed(b); }

    private static double Arg(List<object> args, int i)
    {
        if (args == null || i >= args.Count) throw new ArgumentException("expected 2 numbers: x y");
        double v = WitnessJson.Double(args[i], double.NaN);
        if (double.IsNaN(v)) throw new ArgumentException("'" + args[i] + "' is not a number");
        return v;
    }

    // A 0.15 s 880 Hz sine with a fast exponential decay, as a 16-bit WAV stream.
    private static AudioStreamWav MakeDing()
    {
        int n = (int)(SampleRate * 0.15);
        var bytes = new byte[n * 2];
        for (int i = 0; i < n; i++)
        {
            short s = (short)(Math.Sin(2 * Math.PI * 880 * i / SampleRate) * 0.5 * Math.Exp(-i / (SampleRate * 0.04)) * 32767);
            bytes[i * 2] = (byte)s;
            bytes[i * 2 + 1] = (byte)(s >> 8);
        }
        return new AudioStreamWav { Format = AudioStreamWav.FormatEnum.Format16Bits, MixRate = SampleRate, Stereo = false, Data = bytes };
    }
}
