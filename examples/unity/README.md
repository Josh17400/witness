# Coins: Unity example (unverified)

The standard Witness sample game (docs/ADAPTERS.md) as a Unity 2022.3 project that uses the
`adapters/unity` package through a `file:` reference in `Packages/manifest.json`.

> Not run: the authoring machine has no Unity license. The scripts compile against Unity 2022.3
> reference assemblies; the build and the Witness run below are untested.

* `Assets/Coins/CoinsGame.cs`: the game. It creates its own camera and sprites at startup (no
  hand-made scene), reads input through `WitnessInput` (old Input Manager), logs with `Debug.Log`
  and plays its sound with an `AudioSource` (captured by `AudioRenderer`). It sets
  `WitnessBridge.Reset` / `Snapshot` and registers the `teleport` / `addcoin` calls.
* `Assets/Coins/Editor/CoinsBuild.cs`: creates the empty boot scene and builds a player into `Build/`.

## Run

```
Unity -batchmode -quit -projectPath . -executeMethod CoinsBuild.Build -logFile -
node ../../bin/witness.js doctor
node ../../bin/witness.js test
```

`Unity` is the editor binary of a 2022.3 install (e.g. `"C:/Program Files/Unity/Hub/Editor/2022.3.62f1/Editor/Unity.exe"`).
On macOS/Linux change `launch.command` in `witness.json` to `Build/Coins.app/Contents/MacOS/Coins` or
`Build/Coins.x86_64`. The player runs with `-batchmode` (no window); add `-nographics` to skip the GPU
(screenshots are then unavailable).
