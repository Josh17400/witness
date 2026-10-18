# Coins: Java example

The standard Witness sample game (docs/ADAPTERS.md) in plain Java 8+, using
`adapters/java/Witness.java` straight from the adapter folder.

* `src/coins/CoinsGame.java`: the game as a pure simulation (no clock, no AWT).
* `src/coins/Main.java`: witness mode (`Witness.start` + `Witness.run`) or, without `WITNESS_ADDR`, a
  real-time Swing window (3x scale; arrows/WASD, F8 marks the replay, Esc quits).

`witness.json` launches with `-Djava.awt.headless=true`: witness runs never touch AWT and can never
open a window.

## Run

Needs a JDK (8 or newer) and Node 18+.

```
javac --release 8 -encoding UTF-8 -d build ../../adapters/java/Witness.java src/coins/CoinsGame.java src/coins/Main.java
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

On JDK 8 itself drop `--release 8`. Play and record a replay, then play it back headlessly:

```
WITNESS_RECORD=witness/replays/run.jsonl java -cp build coins.Main
node ../../bin/witness.js replay witness/replays/run.jsonl
```

Kotlin projects use `Witness.java` unchanged (it's ordinary Java on the classpath).
