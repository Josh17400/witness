// The standard Witness sample game ("coins", docs/ADAPTERS.md) for Unity. It builds its own scene at
// startup (camera + sprites), so the project needs no hand-made scene beyond the empty one the build
// script creates. Game logic works in Witness coordinates (x right, y down, 320x180); rendering flips y.
// Input goes through WitnessInput (old Input Manager); logs through Debug.Log; sound through an
// AudioSource (AudioRenderer captures it in witness mode).
using System.Collections.Generic;
using UnityEngine;
using WitnessKit;

public sealed class CoinsGame : MonoBehaviour
{
    private const float Width = 320, Height = 180, Speed = 120, PickupRadius = 12;

    private sealed class Entity
    {
        public int Id;
        public string Type;
        public Vector2 Pos;
        public Transform View;

        public Dictionary<string, object> ToJson()
        {
            var o = new Dictionary<string, object> { { "id", Id }, { "type", Type }, { "pos", new[] { Pos.x, Pos.y } } };
            if (Type == "Player") o["hp"] = 3;
            return o;
        }
    }

    private readonly List<Entity> _coins = new List<Entity>();
    private Entity _player;
    private int _score;
    private Sprite _circle;
    private AudioSource _audio;
    private AudioClip _ding;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Boot()
    {
        if (FindObjectOfType<CoinsGame>() == null) new GameObject("Coins").AddComponent<CoinsGame>();
    }

    private void Awake()
    {
        var cam = new GameObject("Camera").AddComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = Height / 2;
        cam.transform.position = new Vector3(Width / 2, Height / 2, -10);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color32(20, 24, 40, 255);
        cam.gameObject.AddComponent<AudioListener>();

        _circle = MakeCircleSprite();
        _ding = MakeDing();
        _audio = gameObject.AddComponent<AudioSource>();

        WitnessBridge.Hello.Name = "Coins (Unity)";
        WitnessBridge.Hello.Width = (int)Width;
        WitnessBridge.Hello.Height = (int)Height;
        WitnessBridge.Reset = (seed, scene, args) => ResetGame(seed);   // synchronous: no scene reload needed
        WitnessBridge.Snapshot = State;
        WitnessBridge.RegisterCall("teleport", "x y", "move the player", args =>
        {
            _player.Pos = new Vector2(Arg(args, 0), Arg(args, 1));
            Sync(_player);
            return new[] { _player.Pos.x, _player.Pos.y };
        });
        WitnessBridge.RegisterCall("addcoin", "x y", "add a coin, returns the coin count", args =>
        {
            _coins.Add(Spawn(100 + _coins.Count, "Coin", new Vector2(Arg(args, 0), Arg(args, 1))));
            return _coins.Count;
        });
        ResetGame(Witness.Seed);
    }

    private void ResetGame(int seed)
    {
        foreach (var c in _coins) Destroy(c.View.gameObject);
        _coins.Clear();
        if (_player != null) Destroy(_player.View.gameObject);
        _score = 0;
        _player = Spawn(1, "Player", new Vector2(40, 90));
        for (int i = 0; i < 5; i++) _coins.Add(Spawn(10 + i, "Coin", new Vector2(80 + i * 40, i == 0 ? 90 : 60 + ((seed * 7 + i * 13) % 61))));
    }

    private void Update()
    {
        float dt = Time.deltaTime;
        int dx = (Held(KeyCode.RightArrow, KeyCode.D) ? 1 : 0) - (Held(KeyCode.LeftArrow, KeyCode.A) ? 1 : 0);
        int dy = (Held(KeyCode.DownArrow, KeyCode.S) ? 1 : 0) - (Held(KeyCode.UpArrow, KeyCode.W) ? 1 : 0);
        _player.Pos = new Vector2(Mathf.Clamp(_player.Pos.x + dx * Speed * dt, 0, Width), Mathf.Clamp(_player.Pos.y + dy * Speed * dt, 0, Height));
        Sync(_player);
        foreach (var c in _coins.ToArray())
        {
            if (Vector2.Distance(c.Pos, _player.Pos) >= PickupRadius) continue;
            _coins.Remove(c);
            Destroy(c.View.gameObject);
            _score++;
            Debug.Log("coin " + c.Id + " collected");
            _audio.PlayOneShot(_ding);
        }
    }

    private object State()
    {
        var entities = new List<object> { _player.ToJson() };
        foreach (var c in _coins) entities.Add(c.ToJson());
        return new Dictionary<string, object> { { "score", _score }, { "scene", "level1" }, { "player", _player.ToJson() }, { "entities", entities } };
    }

    private static bool Held(KeyCode a, KeyCode b) { return WitnessInput.GetKey(a) || WitnessInput.GetKey(b); }

    private Entity Spawn(int id, string type, Vector2 pos)
    {
        var view = new GameObject(type + " " + id).AddComponent<SpriteRenderer>();
        view.sprite = _circle;
        bool player = type == "Player";
        view.color = player ? new Color32(80, 200, 255, 255) : new Color32(255, 210, 60, 255);
        view.sortingOrder = player ? 1 : 0;
        view.transform.localScale = Vector3.one * (player ? 15 : 11);   // the sprite is 1 unit wide
        var e = new Entity { Id = id, Type = type, Pos = pos, View = view.transform };
        Sync(e);
        return e;
    }

    private static void Sync(Entity e) { e.View.position = new Vector3(e.Pos.x, Height - e.Pos.y, 0); }

    private static float Arg(List<object> args, int i)
    {
        if (args == null || i >= args.Count) throw new System.ArgumentException("expected 2 numbers: x y");
        double v = WitnessJson.Double(args[i], double.NaN);
        if (double.IsNaN(v)) throw new System.ArgumentException("'" + args[i] + "' is not a number");
        return (float)v;
    }

    private static Sprite MakeCircleSprite()
    {
        const int size = 32;
        var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
        var px = new Color32[size * size];
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float fx = x + 0.5f - size / 2f, fy = y + 0.5f - size / 2f;
                px[y * size + x] = fx * fx + fy * fy <= size * size / 4f ? new Color32(255, 255, 255, 255) : new Color32(0, 0, 0, 0);
            }
        tex.SetPixels32(px);
        tex.Apply();
        return Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), size);
    }

    // A 0.15 s 880 Hz sine with a fast exponential decay.
    private static AudioClip MakeDing()
    {
        const int rate = 22050;
        int n = (int)(rate * 0.15f);
        var s = new float[n];
        for (int i = 0; i < n; i++) s[i] = Mathf.Sin(2 * Mathf.PI * 880 * i / rate) * 0.5f * Mathf.Exp(-i / (rate * 0.04f));
        var clip = AudioClip.Create("ding", n, 1, rate, false);
        clip.SetData(s, 0);
        return clip;
    }
}
