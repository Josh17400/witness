// Type definitions for the Witness JS/TS adapter (witness.js). Protocol: docs/PROTOCOL.md.

/** "witness": driven by the CLI · "record": normal play written as a replay · "off": inert. */
export type WitnessMode = "witness" | "record" | "off";

/** Protocol input events (docs/PROTOCOL.md section 4). `frame` is absolute since the last reset. */
export type WitnessEvent =
  | { frame: number; type: "key"; key: string; down: boolean }
  /** `fromTouch`: the mouse fallback of finger 0 (delivered right after its touch event; never recorded). */
  | { frame: number; type: "mouse"; x: number; y: number; button?: 0 | 1 | 2; down?: boolean; fromTouch?: boolean }
  | { frame: number; type: "wheel"; dx?: number; dy: number }
  | { frame: number; type: "text"; text: string }
  | { frame: number; type: "action"; action: string; down: boolean }
  | { frame: number; type: "pad"; button: string; down: boolean }
  | { frame: number; type: "axis"; axis: string; value: number }
  /** A finger: id 0 = first finger down (stable until up), x/y in game pixels like the mouse, pressure 0..1 (1 when not given). */
  | { frame: number; type: "touch"; id: number; x: number; y: number; phase: WitnessTouchPhase; pressure?: number };

/** "cancel": the system ended the touch (touchcancel / pointercancel). It ends the finger like "up" but is not a completed tap. */
export type WitnessTouchPhase = "down" | "move" | "up" | "cancel";

/** The same events without `frame`, as written into replay lines. */
export type WitnessRecordedEvent = WitnessEvent extends infer E ? (E extends { frame: number } ? Omit<E, "frame"> : never) : never;

export interface ResetArgs {
  /** Already used to reseed Math.random / witness.random() before reset runs. */
  seed: number;
  scene?: string;
  params: Record<string, unknown>;
}

/** A screenshot the game produces itself. `data` may be raw RGBA bytes (encoded for you) or base64. */
export interface WitnessImage {
  width: number;
  height: number;
  format?: "rgba8" | "png";
  data: Uint8Array | Uint8ClampedArray | ArrayBuffer | string;
}

/** PCM the game produces itself (interleaved). `data` may be raw samples (encoded for you) or base64. */
export interface WitnessAudio {
  sampleRate: number;
  channels: number;
  format: "f32" | "s16";
  data: Float32Array | Int16Array | ArrayBuffer | string;
}

export type WitnessCallFn = (...args: any[]) => unknown;
export interface WitnessCall {
  run: WitnessCallFn;
  /** Shown by `witness doctor`, e.g. "x y". */
  args?: string;
  help?: string;
}

export interface StartOptions {
  name?: string;
  /** Free text for the hello, auto-detected when omitted ("Phaser 3.90.0", "three.js r169", ...). */
  engine?: string;
  language?: string;
  /** Frames per simulated second (default 60). */
  fps?: number;
  /** Logical size in game pixels: mouse events use these coordinates (default: the canvas size). */
  size?: [number, number];
  /** Keys the game uses (shown by doctor). */
  keys?: string[];

  /** Return the game to a deterministic start. Required for `reset` (and for recording). */
  reset?(args: ResetArgs): void | Promise<void>;
  /** Advance one frame by dt seconds. Optional in browsers (the rAF takeover runs the game's own loop). */
  step?(dt: number, frame: number): void;
  /** JSON-friendly state. Conventions: entities [{id, type, pos}], scene, player. */
  snapshot?(): unknown | Promise<unknown>;
  /** Handle one input event yourself; return true to skip the default DOM injection (browsers). */
  input?(event: WitnessEvent): boolean | void;
  /** Receive `action` events (input-mapping layers). Without it, an action is pressed as a key of that name. */
  action?(name: string, down: boolean): void;
  /** The game handles touch itself: finger 0 is NOT also delivered as mouse events (default false: it is).
   *  Sent in the hello as "touch": true. Browsers also skip the fallback when the page calls preventDefault()
   *  on the touch's pointerdown/touchstart (or on a touchmove, for that move). */
  touch?: boolean;
  calls?: Record<string, WitnessCallFn | WitnessCall>;
  /** Variables visible to `eval` expressions (a function is called for every eval). */
  scope?: Record<string, unknown> | (() => Record<string, unknown>);

  /** Browser: the canvas to capture and map mouse coordinates to (element, selector, list, or getter). Default: the largest <canvas>. */
  canvas?: HTMLCanvasElement | string | ArrayLike<HTMLCanvasElement> | (() => HTMLCanvasElement | ArrayLike<HTMLCanvasElement>);
  /** Browser: where key events are dispatched (default: a focusable canvas, else the focused element, else body). */
  keyTarget?: EventTarget | (() => EventTarget);
  /** "rgba8" (default, exact) or "png" (smaller for big canvases). */
  screenshotFormat?: "rgba8" | "png";
  /** Custom screenshots (Node games, DOM UIs). May also return a canvas to capture. */
  screenshot?(opts: { scale: number }): WitnessImage | HTMLCanvasElement | Promise<WitnessImage | HTMLCanvasElement>;
  /** Custom audio instead of the WebAudio tap / mixers. Everything since the last call or reset. */
  audio?(): WitnessAudio | Promise<WitnessAudio>;
  perf?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Called on `quit` and when the CLI disconnects. */
  quit?(): void;
  /** Node: exit the process on quit/disconnect (default true). */
  exitOnQuit?: boolean;
  /** Record mode: force this seed (default: random, or WITNESS_SEED / ?witness_seed=). */
  seed?: number;
  /** Yield to the event loop after every frame even without a takeover (default: only with one). */
  yieldEachFrame?: boolean;
  /** Browser: wait for pictures and fonts before the hello (default true; see witness.ready()). */
  ready?: boolean | WitnessReadyOptions;
}

export interface WitnessReadyOptions {
  /** Real display frames to wait after decoding (default 2). */
  frames?: number;
  /** Real milliseconds to wait after that (default 0). */
  ms?: number;
  /** Most real milliseconds to spend decoding (default 10000). */
  timeout?: number;
}

/** A PCM capture buffer that follows simulated time (games that synthesize their own sound). */
export interface WitnessMixer {
  readonly sampleRate: number;
  readonly channels: number;
  /** False outside witness mode: play() is then a no-op. */
  readonly enabled: boolean;
  /** Mix samples in at the current simulated time (+delay seconds). Stereo input is interleaved. */
  play(samples: ArrayLike<number>, opts?: { delay?: number; volume?: number }): void;
}

export interface WitnessInputState {
  keys: Set<string>;
  mouse: { x: number; y: number; buttons: number };
  /** Fingers that are down: finger id -> position (game pixels) and pressure. */
  touches: Map<number, { x: number; y: number; pressure: number }>;
  pad: { buttons: number[]; axes: number[] };
  actions: Set<string>;
}

/** Page-level configuration, read at import: set `globalThis.WITNESS_CONFIG` before importing. */
export interface WitnessConfig {
  /** host:port of the CLI (instead of ?witness= / WITNESS_ADDR, e.g. for Tauri). */
  addr?: string;
  /** Recording target: "1" (download with F9) or an endpoint URL (browser); a file path (Node). */
  record?: string;
  seed?: number;
  /** false disables the whole takeover (rAF + timers + clock). */
  takeover?: boolean;
  raf?: boolean;
  timers?: boolean;
  /** false keeps the real AudioContext in witness mode (no audio capture). */
  webaudio?: boolean;
  /** false stops console.* from being forwarded as game logs. */
  console?: boolean;
  /** false leaves CSS transitions / animations / element.animate() on real time (default: on the virtual clock). */
  animations?: boolean;
  /** false leaves <video> elements playing (default: paused in witness mode, they run on real time). */
  videos?: boolean;
  /** Seconds of audio each captured AudioContext can hold (default 300; past it silent, its clock goes on). */
  audioSeconds?: number;
  /** Sample rate of captured AudioContexts that don't ask for one (default 24000). */
  audioRate?: number;
  /** false: a source node's "ended" comes from the offline renderer (uneven timing) instead of the virtual clock. */
  virtualEnded?: boolean;
  /** false: iPhone-Safari audio policy on pages without the CLI's init script (contexts start suspended; resume()
   *  only during a gesture). Browser launches take it from --no-auto-unlock instead. ?witness_audio_unlock=0 */
  audioUnlock?: boolean;
  /** What Date.now() says at import in witness/record mode (default 2026-01-01T00:00:00Z): an ISO date, ms since
   *  1970, or "today" (00:00 UTC). The CLI sets it from witness.json clock.epoch (?witness_epoch= / WITNESS_EPOCH) and
   *  sends it with every reset, where the Date restarts at it. */
  epoch?: string | number;
}

declare global {
  // eslint-disable-next-line no-var
  var WITNESS_CONFIG: WitnessConfig | undefined;
  /** The page's adapter instance (also when the CLI injected it before the page's scripts: launch.inject). */
  // eslint-disable-next-line no-var
  var __witnessApi: WitnessApi | undefined;
  /** Witness mode, browser: finite CSS / Web Animations still running (0 = settled). */
  // eslint-disable-next-line no-var
  var __witnessAnimating: (() => number) | undefined;
}

export interface WitnessDomHelpers {
  /** Tap an element (or the first match of a selector) at its centre: touch pointer events, mouse events, click.
   *  "ok", "blocked by <what covers it>" (warned), or "not found: <selector>". */
  tap(el: Element | string): string;
  /** What can be tapped (buttons, links, inputs, [role=button], [onclick]), visible, in view first. */
  tappables(root?: Element | string): { label: string; id: string | null }[];
}

export interface WitnessApi {
  readonly version: string;
  readonly mode: WitnessMode;
  /** True when the Witness CLI drives the game. */
  active(): boolean;
  /** True while a replay is being recorded. */
  recording(): boolean;
  /** Hand the game to Witness. Call once, after loading. Resolves at once when inactive. */
  start(options?: StartOptions): Promise<WitnessApi>;
  /** Node / custom loops: virtualize setTimeout/setInterval/performance.now/Date (browsers do it at import). */
  takeover(opts?: { raf?: boolean; timers?: boolean }): boolean;
  /** The seed for the game's own RNGs. */
  seed(): number;
  /** Seeded random in [0, 1); Math.random uses the same stream in witness/record mode. */
  random(): number;
  /** A game log line: log("coin collected") or log("warn" | "error" | "info", ...). Errors fail tests. */
  log(levelOrMessage: unknown, ...message: unknown[]): void;
  /** Announce a sound the game just started (named sounds in 'witness listen'). No-op unless Witness drives the game. */
  sound(name: string, opts?: { volume?: number; pos?: [number, number] }): void;
  /** Flag this moment in the recording (F8 does it in browsers). */
  mark(label?: string): void;
  /** Normal play with recording on (Node / custom loops): append one frame; returns the dt to simulate. */
  recordFrame(dt: number, events?: WitnessRecordedEvent[]): number;
  /** Queue an input event for the current frame line (mouse events with fromTouch are skipped). */
  recordInput(event: WitnessRecordedEvent): void;
  /** Record a finger: id 0 = first finger down (reuse ids after up), game pixels, phase default "move". */
  recordTouch(id: number, x: number, y: number, phase?: WitnessTouchPhase, pressure?: number): void;
  /** Browser recording: download (F9 mode) or flush to the endpoint. Returns the file name / URL. */
  saveRecording(): string | null;
  /** Events applied at the current frame (for games that pull input). */
  inputEvents(): WitnessEvent[];
  readonly input: WitnessInputState;
  createMixer(opts?: { sampleRate?: number; channels?: 1 | 2 }): WitnessMixer;
  /** Browser: wait until pictures are decoded and fonts are ready (start() does it in witness mode). */
  ready(opts?: WitnessReadyOptions): Promise<void>;
  /** Browser: run <script type="text/witness"> / [data-witness-deferred] classic scripts in order; returns how many. */
  boot(opts?: { selector?: string }): Promise<number>;
  /** DOM games: tap elements and list what can be tapped. */
  readonly dom: WitnessDomHelpers;
  /** Finite CSS / Web Animations still running (0 = settled). */
  animating(): number;
  /** Frames / simulated seconds since the last reset. */
  readonly frame: number;
  readonly time: number;
  /** The real, un-virtualized timer and clock functions. */
  readonly real: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    requestAnimationFrame: ((cb: FrameRequestCallback) => number) | null;
    cancelAnimationFrame: ((id: number) => void) | null;
    now(): number;
    Date: DateConstructor;
    random(): number;
  };
}

export declare const witness: WitnessApi;
export declare const mode: WitnessMode;
export declare const active: WitnessApi["active"];
export declare const start: WitnessApi["start"];
export declare const takeover: WitnessApi["takeover"];
export declare const seed: WitnessApi["seed"];
export declare const random: WitnessApi["random"];
export declare const log: WitnessApi["log"];
export declare const mark: WitnessApi["mark"];
export declare const sound: WitnessApi["sound"];
export declare const recordFrame: WitnessApi["recordFrame"];
export declare const createMixer: WitnessApi["createMixer"];
export declare const ready: WitnessApi["ready"];
export declare const boot: WitnessApi["boot"];
export declare class Mixer implements WitnessMixer {
  constructor(opts?: { sampleRate?: number; channels?: 1 | 2 });
  readonly sampleRate: number;
  readonly channels: number;
  readonly enabled: boolean;
  play(samples: ArrayLike<number>, opts?: { delay?: number; volume?: number }): void;
}
export default witness;
