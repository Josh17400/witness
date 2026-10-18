// Coins for .NET: witness mode when launched by the Witness CLI, otherwise a real-time console game
// (ASCII view, arrows/WASD to move, F8 marks the replay, Esc quits). Set WITNESS_RECORD=run.jsonl
// to record a replay that `witness replay run.jsonl` plays back.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using WitnessKit;

namespace Coins
{
    public static class Program
    {
        public static int Main()
        {
            var game = new CoinsGame();
            var hello = new WitnessHello
            {
                Name = "Coins (C#)",
                Engine = ".NET console",
                Fps = CoinsGame.Fps,
                Width = CoinsGame.Width,
                Height = CoinsGame.Height,
                Calls = { new WitnessCall("teleport", "x y", "move the player"), new WitnessCall("addcoin", "x y", "add a coin, returns the coin count") },
                Keys = new List<string> { "left", "right", "up", "down", "w", "a", "s", "d" },
            };
            var handlers = new WitnessHandlers
            {
                Reset = (seed, scene, args) => game.Reset(seed),
                Input = game.Apply,
                Step = game.Step,
                Snapshot = game.Snapshot,
                Screenshot = scale => game.Render(),
                Call = game.Call,
                Perf = () => new Dictionary<string, object> { { "counts", new Dictionary<string, object> { { "coins", game.CoinsLeft } } } },
            };

            if (Witness.Active)
            {
                // A crash under test must print and exit non-zero, never raise a Windows error dialog.
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                {
                    Console.Error.WriteLine("[coins] crashed: " + e.ExceptionObject);
                    Environment.Exit(3);
                };
                Witness.Pcm = new WitnessPcm(CoinsGame.SampleRate, 1);   // before Start, so hello advertises "audio"
                if (!Witness.Start(hello, handlers)) return 1;
                Witness.Run(handlers);
                return 0;
            }

            Witness.Start(hello);   // starts recording when WITNESS_RECORD is set
            game.Reset(Witness.Seed);
            return RealTime(game);
        }

        // ------------------------------------------------------------------ real-time console mode

        private const double HoldSeconds = 0.55;   // consoles report presses, not releases: a key counts as held until its repeats stop

        private static int RealTime(CoinsGame game)
        {
            try
            {
                Console.CursorVisible = false;
                Console.Clear();
            }
            catch (Exception)
            {
                Console.Error.WriteLine("Coins needs an interactive console for real-time play. To drive it headless, use the Witness CLI (witness test / doctor).");
                return 2;
            }

            var lastSeen = new Dictionary<string, double>();
            var clock = Stopwatch.StartNew();
            double now = 0;
            var frameEvents = new List<WitnessEvent>();
            try
            {
                for (;;)
                {
                    double t = clock.Elapsed.TotalSeconds, dt = Math.Min(0.1, t - now);
                    now = t;
                    frameEvents.Clear();
                    while (Console.KeyAvailable)
                    {
                        var key = Console.ReadKey(true).Key;
                        if (key == ConsoleKey.Escape) return 0;
                        if (key == ConsoleKey.F8) { Witness.Mark("F8"); continue; }
                        string name = WitnessKeys.Normalize(key.ToString());
                        if (!lastSeen.ContainsKey(name)) frameEvents.Add(WitnessEvent.KeyEvent(name, true));
                        lastSeen[name] = now;
                    }
                    foreach (var kv in new List<KeyValuePair<string, double>>(lastSeen))
                    {
                        if (now - kv.Value < HoldSeconds) continue;
                        lastSeen.Remove(kv.Key);
                        frameEvents.Add(WitnessEvent.KeyEvent(kv.Key, false));
                    }
                    foreach (var e in frameEvents) game.Apply(e);
                    game.Step(dt);
                    Witness.RecordFrame(dt, frameEvents);
                    Draw(game);
                    Thread.Sleep(Math.Max(0, (int)((now + 1.0 / CoinsGame.Fps - clock.Elapsed.TotalSeconds) * 1000)));
                }
            }
            finally
            {
                Witness.StopRecording();
                Console.CursorVisible = true;
            }
        }

        // 64×18 characters: one cell = 5×10 game pixels.
        private static void Draw(CoinsGame game)
        {
            const int Cols = 64, Rows = 18;
            var grid = new char[Rows, Cols];
            for (int r = 0; r < Rows; r++) for (int c = 0; c < Cols; c++) grid[r, c] = '.';
            foreach (var coin in game.CoinList) Plot(grid, coin.X, coin.Y, 'o', Cols, Rows);
            Plot(grid, game.Player.X, game.Player.Y, '@', Cols, Rows);
            var sb = new StringBuilder();
            sb.Append("Coins  score ").Append(game.Score).Append("   arrows/WASD move, F8 mark, Esc quit");
            sb.Append(Witness.Recording ? "   [recording]" : "").Append("        \n");
            for (int r = 0; r < Rows; r++)
            {
                for (int c = 0; c < Cols; c++) sb.Append(grid[r, c]);
                sb.Append('\n');
            }
            Console.SetCursorPosition(0, 0);
            Console.Write(sb.ToString());
        }

        private static void Plot(char[,] grid, double x, double y, char ch, int cols, int rows)
        {
            int c = Math.Min(cols - 1, Math.Max(0, (int)(x / 5))), r = Math.Min(rows - 1, Math.Max(0, (int)(y / 10)));
            grid[r, c] = ch;
        }
    }
}
