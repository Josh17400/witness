// Unit checks for Witness.cs. Run: dotnet run --project adapters/csharp/tests/selftest/SelfTest.csproj
// With WITNESS_RECORD=<file> set it also records a short replay (walk right for 0.5 s, one mark).
using System;
using System.Collections.Generic;
using System.Numerics;
using WitnessKit;

internal static class SelfTest
{
    private static int _failed, _passed;

    private static void Eq(object want, object got, string what)
    {
        if (Equals(want, got)) { _passed++; return; }
        _failed++;
        Console.WriteLine("FAIL " + what + ": want <" + want + "> got <" + got + ">");
    }

    private struct Sample
    {
        public int Id;
        public Vector2 Pos;
        public string Name;
    }

    private static int Main()
    {
        // JSON writer
        Eq("{\"a\":1,\"b\":[1.5,-2,\"x\\\"y\\n\"],\"c\":null,\"d\":true}",
            WitnessJson.Write(new Dictionary<string, object> { { "a", 1 }, { "b", new object[] { 1.5, -2L, "x\"y\n" } }, { "c", null }, { "d", true } }), "write basics");
        Eq("[\"NaN\",\"Infinity\",\"-Infinity\",0.1,0.1]", WitnessJson.Write(new object[] { double.NaN, double.PositiveInfinity, float.NegativeInfinity, 0.1, 0.1f }), "write non-finite + float");
        Eq("\"\\u0001\\u2028\"", WitnessJson.Write("\u0001\u2028"), "write control + line separator escapes");
        Eq("[1,2,3]", WitnessJson.Write(new Vector3(1, 2, 3)), "vector as array");
        Eq("{\"Id\":7,\"Pos\":[0.5,2],\"Name\":\"n\"}", WitnessJson.Write(new Sample { Id = 7, Pos = new Vector2(0.5f, 2), Name = "n" }), "struct fields via reflection");
        Eq("\"Friday\"", WitnessJson.Write(DayOfWeek.Friday), "enum as name");

        // JSON reader
        var o = (Dictionary<string, object>)WitnessJson.Parse(" {\"id\": 3, \"cmd\":\"step\", \"dt\": 1e-2, \"n\": -0.5, \"s\": \"\\u00e9\\t\\/\", \"a\": [], \"o\": {}} ");
        Eq(3L, o["id"], "parse integer as long");
        Eq(0.01, o["dt"], "parse exponent");
        Eq(-0.5, o["n"], "parse negative");
        Eq("\u00e9\t/", o["s"], "parse escapes");
        Eq(0, ((List<object>)o["a"]).Count, "parse empty array");
        Eq(0, ((Dictionary<string, object>)o["o"]).Count, "parse empty object");
        Eq(9007199254740993L, WitnessJson.Parse("9007199254740993"), "big integers stay exact");
        foreach (var bad in new[] { "{", "[1,]", "{\"a\" 1}", "tru", "\"abc", "1 2" })
        {
            bool threw = false;
            try { WitnessJson.Parse(bad); } catch (FormatException) { threw = true; }
            Eq(true, threw, "rejects " + bad);
        }
        string roundTrip = "{\"k\":[1,2.25,\"\\\\\",{\"z\":false}]}";
        Eq(roundTrip, WitnessJson.Write(WitnessJson.Parse(roundTrip)), "round trip");

        // Keys
        Eq("left", WitnessKeys.Normalize("LeftArrow"), "Unity KeyCode.LeftArrow");
        Eq("1", WitnessKeys.Normalize("Alpha1"), "Unity KeyCode.Alpha1");
        Eq("1", WitnessKeys.Normalize("Digit1"), "Input System Key.Digit1");
        Eq("1", WitnessKeys.Normalize("D1"), "MonoGame Keys.D1");
        Eq("1", WitnessKeys.Normalize("Key1"), "Godot Key.Key1");
        Eq("enter", WitnessKeys.Normalize("Return"), "Return");
        Eq("shift", WitnessKeys.Normalize("LeftShift"), "LeftShift");
        Eq("ctrl", WitnessKeys.Normalize("LeftControl"), "LeftControl");
        Eq("space", WitnessKeys.Normalize("Spacebar"), "ConsoleKey.Spacebar");
        Eq("d", WitnessKeys.Normalize("D"), "plain letter D");
        Eq("f8", WitnessKeys.Normalize("F8"), "function key");
        ConsoleKey ck;
        Eq(true, WitnessKeys.TryParse("right", out ck) && ck == ConsoleKey.RightArrow, "TryParse right → RightArrow");
        Eq(true, WitnessKeys.TryParse("1", out ck) && ck == ConsoleKey.D1, "TryParse 1 → D1 (not the value 1)");
        Eq(true, WitnessKeys.TryParse("space", out ck) && ck == ConsoleKey.Spacebar, "TryParse space → Spacebar");
        Eq(true, WitnessKeys.TryParse("f12", out ck) && ck == ConsoleKey.F12, "TryParse f12");
        Eq(false, WitnessKeys.TryParse("nosuchkey", out ck), "TryParse unknown fails");

        // PCM: synchronized with simulated time; tails carry over
        var pcm = new WitnessPcm(1000, 1);
        pcm.Play(new float[] { 1, 1, 1, 1, 1 });
        pcm.SyncTo(0.003);
        var first = pcm.Drain();
        Eq(3, first.Samples.Length, "drain stops at now");
        pcm.SyncTo(0.010);
        var second = pcm.Drain();
        Eq(7, second.Samples.Length, "tail + silence");
        Eq(1f, second.Samples[1], "tail kept");
        Eq(0f, second.Samples[2], "then silence");
        var stereo = new WitnessPcm(100, 2);
        stereo.SyncTo(0.05);
        Eq(10, stereo.Drain().Samples.Length, "interleaved stereo length");

        // Events
        var ev = WitnessEvent.FromJson((Dictionary<string, object>)WitnessJson.Parse("{\"frame\":30,\"type\":\"mouse\",\"x\":640,\"y\":360,\"button\":2,\"down\":true}"));
        Eq(30, ev.Frame, "event frame");
        Eq(2, ev.Button, "event button");
        Eq(true, ev.IsDown, "event down");
        Eq("{\"type\":\"mouse\",\"x\":640,\"y\":360,\"button\":2,\"down\":true}", WitnessJson.Write(ev.ToJson(false)), "event replay shape");
        var move = WitnessEvent.FromJson((Dictionary<string, object>)WitnessJson.Parse("{\"frame\":1,\"type\":\"mouse\",\"x\":5,\"y\":6}"));
        Eq(null, move.Down, "mouse move has no down");
        var pad = WitnessEvent.FromJson((Dictionary<string, object>)WitnessJson.Parse("{\"frame\":1,\"type\":\"pad\",\"button\":\"a\",\"down\":true}"));
        Eq("a", pad.PadButton, "pad button name");

        // Images
        var img = WitnessImage.FromRgba(2, 2, new byte[] { 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4 }, bottomUp: true);
        Eq((byte)3, img.Rgba[0], "bottom-up flip");
        var big = img.Scaled(2);
        Eq(4, big.Width, "scaled width");
        Eq((byte)3, big.Rgba[4], "nearest neighbour");

        // Inactive = inert
        Eq(false, Witness.Active, "inactive without WITNESS_ADDR");
        Witness.Info("ignored");
        string record = Environment.GetEnvironmentVariable("WITNESS_RECORD");
        if (!string.IsNullOrEmpty(record))
        {
            // Walk right for 0.5 s with one mark: `witness replay <file>` plays it on any coins example.
            Eq(false, Witness.Start(new WitnessHello { Name = "SelfTest", Fps = 60 }), "Start returns false outside witness mode");
            Eq(true, Witness.Recording, "recording started");
            for (int f = 0; f < 45; f++)
            {
                var evs = new List<WitnessEvent>();
                if (f == 0) evs.Add(WitnessEvent.KeyEvent("right", true));
                if (f == 30) evs.Add(WitnessEvent.KeyEvent("right", false));
                if (f == 20) Witness.Mark("F8");
                Witness.RecordFrame(1.0 / 60, evs);
            }
            Witness.StopRecording();
            var lines = System.IO.File.ReadAllLines(record);
            Eq(46, lines.Length, "replay has a header + 45 frames");
            var head = (Dictionary<string, object>)WitnessJson.Parse(lines[0]);
            Eq(1L, head["replay"], "replay header");
            Eq((long)Witness.Seed, head["seed"], "replay seed");
            Eq("F8", ((Dictionary<string, object>)WitnessJson.Parse(lines[21]))["mark"], "mark on frame 20");
            Eq("{\"f\":0,\"dt\":0.016666666666666666,\"in\":[{\"type\":\"key\",\"key\":\"right\",\"down\":true}]}", lines[1], "frame line shape");
        }
        else
        {
            Witness.RecordFrame(0.016);
            Eq(false, Witness.Recording, "not recording without WITNESS_RECORD");
        }

        Console.WriteLine(_failed == 0 ? "selftest: all " + _passed + " checks passed" : "selftest: " + _failed + " FAILED, " + _passed + " passed");
        return _failed == 0 ? 0 : 1;
    }
}
