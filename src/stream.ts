import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * YouTube RTMP streaming around ffmpeg.
 *
 * Why ffmpeg and not OBS: OBS is a GUI with its own updater, profiles and a large surface we
 * cannot version; ffmpeg is one binary with explicit flags, so the whole pipeline is a
 * 60-line argument builder that a test can check. Everything secret stays in the environment.
 *
 * The stream key never appears in logs: `redactTarget` is used for every message.
 */

export type StreamSource = "desktop" | "x11" | "test";

export interface StreamConfig {
  ffmpegPath: string;
  source: StreamSource;
  fps: number;
  bitrateKbps: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  display: string;
  /** RTMP url with the key, or a file path when running without YouTube. */
  target: string;
  targetKind: "rtmp" | "file";
  keyframeSec: number;
  preset: string;
}

const SOURCES: readonly StreamSource[] = ["desktop", "x11", "test"];
const DEFAULT_RTMP = "rtmp://a.rtmp.youtube.com/live2";

function fail(message: string): never {
  throw new Error(`stream config: ${message}`);
}

function readInt(read: (name: string) => string | undefined, name: string, fallback: number, min: number, max: number): number {
  const raw = (read(name) ?? "").trim();
  if (raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be an integer in ${min}..${max}, got "${raw}"`);
  }
  return value;
}

/**
 * Builds the streaming config from the environment.
 * Resolution and bitrate are validated because x264 with yuv420p silently refuses odd sizes.
 */
export function parseStreamConfig(read: (name: string) => string | undefined, platform: NodeJS.Platform = process.platform): StreamConfig {
  const sourceRaw = ((read("STREAM_SOURCE") ?? "").trim() || (platform === "win32" ? "desktop" : "x11")) as StreamSource;
  if (!SOURCES.includes(sourceRaw)) fail(`STREAM_SOURCE must be one of ${SOURCES.join(", ")}, got "${sourceRaw}"`);

  const width = readInt(read, "STREAM_WIDTH", 1280, 320, 2560);
  const height = readInt(read, "STREAM_HEIGHT", 720, 240, 1440);
  if (width % 2 !== 0 || height % 2 !== 0) fail(`STREAM_WIDTH/HEIGHT must be even for yuv420p, got ${width}x${height}`);

  const file = (read("STREAM_OUTPUT") ?? "").trim();
  const key = (read("YOUTUBE_STREAM_KEY") ?? "").trim();
  const base = (read("YOUTUBE_RTMP_URL") ?? "").trim() || DEFAULT_RTMP;

  if (file !== "") {
    return {
      ffmpegPath: (read("FFMPEG_PATH") ?? "").trim() || "ffmpeg",
      source: sourceRaw,
      fps: readInt(read, "STREAM_FPS", 30, 10, 60),
      bitrateKbps: readInt(read, "STREAM_BITRATE_KBPS", 2500, 500, 20000),
      width,
      height,
      offsetX: readInt(read, "STREAM_OFFSET_X", 0, 0, 10000),
      offsetY: readInt(read, "STREAM_OFFSET_Y", 0, 0, 10000),
      display: (read("STREAM_DISPLAY") ?? "").trim() || ":99",
      target: file,
      targetKind: "file",
      keyframeSec: readInt(read, "STREAM_KEYFRAME_SEC", 2, 1, 10),
      preset: (read("STREAM_PRESET") ?? "").trim() || "veryfast",
    };
  }

  if (key === "") {
    fail("YOUTUBE_STREAM_KEY must be set (or STREAM_OUTPUT to record to a file instead)");
  }

  return {
    ffmpegPath: (read("FFMPEG_PATH") ?? "").trim() || "ffmpeg",
    source: sourceRaw,
    fps: readInt(read, "STREAM_FPS", 30, 10, 60),
    bitrateKbps: readInt(read, "STREAM_BITRATE_KBPS", 2500, 500, 20000),
    width,
    height,
    offsetX: readInt(read, "STREAM_OFFSET_X", 0, 0, 10000),
    offsetY: readInt(read, "STREAM_OFFSET_Y", 0, 0, 10000),
    display: (read("STREAM_DISPLAY") ?? "").trim() || ":99",
    target: `${base.replace(/\/+$/u, "")}/${key}`,
    targetKind: "rtmp",
    keyframeSec: readInt(read, "STREAM_KEYFRAME_SEC", 2, 1, 10),
    preset: (read("STREAM_PRESET") ?? "").trim() || "veryfast",
  };
}

/** Loads `.env` when present; used by `scripts/stream.ts` only, so the API never needs a key. */
export function loadStreamConfig(envFile = ".env"): StreamConfig {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return parseStreamConfig((name) => process.env[name], process.platform);
}

/** The exact ffmpeg command line for a capture source and target. */
export function buildFfmpegArgs(config: StreamConfig): string[] {
  const size = `${config.width}x${config.height}`;
  const gop = String(config.fps * config.keyframeSec);

  const args = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1"];

  if (config.source === "desktop") {
    args.push(
      "-f", "gdigrab",
      "-framerate", String(config.fps),
      "-offset_x", String(config.offsetX),
      "-offset_y", String(config.offsetY),
      "-video_size", size,
      "-i", "desktop",
    );
  } else if (config.source === "x11") {
    const display = config.display.includes(".") ? config.display : `${config.display}.0`;
    args.push("-f", "x11grab", "-framerate", String(config.fps), "-video_size", size, "-i", display);
  } else {
    args.push("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${config.fps}`);
  }

  // Silent stereo track: YouTube expects audio and flags video-only streams as broken.
  args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  args.push("-map", "0:v:0", "-map", "1:a:0");
  args.push(
    "-c:v", "libx264",
    "-preset", config.preset,
    "-tune", "zerolatency",
    "-b:v", `${config.bitrateKbps}k`,
    "-maxrate", `${config.bitrateKbps}k`,
    "-bufsize", `${config.bitrateKbps * 2}k`,
    "-pix_fmt", "yuv420p",
    "-g", gop,
    "-keyint_min", gop,
    "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
  );

  // Recording to a file overwrites; an RTMP target must never be "overwritten".
  if (config.targetKind === "file") args.push("-y");
  args.push("-f", "flv", config.target);
  return args;
}

/** Target safe for logs: the stream key is a password, so it is always masked. */
export function redactTarget(config: StreamConfig): string {
  if (config.targetKind === "file") return config.target;
  const cut = config.target.lastIndexOf("/");
  return cut === -1 ? "***" : `${config.target.slice(0, cut)}/***`;
}

export interface StreamProgress {
  frame?: number;
  fps?: number;
  bitrateKbps?: number;
}

/** ffmpeg -progress emits `key=value` lines; only the three numbers we act on are parsed. */
export function parseProgressLine(line: string): StreamProgress | null {
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();

  if (key === "frame") {
    const frame = Number(value);
    return Number.isFinite(frame) ? { frame } : null;
  }
  if (key === "fps") {
    const fps = Number(value);
    return Number.isFinite(fps) ? { fps } : null;
  }
  if (key === "bitrate") {
    const match = /^([\d.]+)kbits\/s$/u.exec(value);
    const bitrateKbps = match?.[1] ? Number(match[1]) : Number.NaN;
    return Number.isFinite(bitrateKbps) ? { bitrateKbps } : null;
  }
  return null;
}

/** The subset of a child process the supervisor needs, so tests can fake it. */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (command: string, args: string[]) => SpawnedProcess;

export interface StreamSupervisorOptions {
  config: StreamConfig;
  spawnFn?: SpawnLike;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Backoff cap; the delay doubles from 1 s up to this value. */
  maxBackoffMs?: number;
  /** After this many consecutive restarts the supervisor gives up instead of looping forever. */
  maxRestarts?: number;
  killTimeoutMs?: number;
}

function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      onLine(buffer.slice(0, index).trim());
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
}

/**
 * Keeps one ffmpeg process alive: restarts with exponential backoff when the stream drops
 * (YouTube rotates RTMP endpoints, the network blips, the encoder dies), and stops cleanly.
 */
export class StreamSupervisor {
  readonly #config: StreamConfig;
  readonly #spawn: SpawnLike;
  readonly #log: (event: string, data: Record<string, unknown>) => void;
  readonly #maxBackoffMs: number;
  readonly #maxRestarts: number;
  readonly #killTimeoutMs: number;

  #child: SpawnedProcess | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopping = false;
  #running = false;
  #restarts = 0;
  #progress: StreamProgress = {};
  #stderrLines = 0;

  constructor(options: StreamSupervisorOptions) {
    this.#config = options.config;
    this.#spawn = options.spawnFn ?? ((command, args) => spawn(command, args) as unknown as SpawnedProcess);
    this.#log = options.log ?? (() => undefined);
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#maxRestarts = options.maxRestarts ?? 10;
    this.#killTimeoutMs = options.killTimeoutMs ?? 5_000;
  }

  get running(): boolean {
    return this.#running;
  }

  get restarts(): number {
    return this.#restarts;
  }

  get progress(): StreamProgress {
    return { ...this.#progress };
  }

  start(): void {
    if (this.#running) throw new Error("stream is already running");
    this.#running = true;
    this.#stopping = false;
    this.#launch();
  }

  /** Terminates ffmpeg (SIGTERM, then SIGKILL after the timeout) and cancels a pending restart. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    const child = this.#child;
    if (!child) return;

    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    child.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), this.#killTimeoutMs)),
    ]);
    if (timedOut) child.kill("SIGKILL");
    if (this.#child === child) this.#child = null;
  }

  #launch(): void {
    const args = buildFfmpegArgs(this.#config);
    this.#log("stream.starting", { target: redactTarget(this.#config), source: this.#config.source });

    let child: SpawnedProcess;
    try {
      child = this.#spawn(this.#config.ffmpegPath, args);
    } catch (error) {
      this.#log("stream.spawn_failed", { message: error instanceof Error ? error.message : String(error) });
      this.#scheduleRestart();
      return;
    }

    this.#child = child;
    this.#progress = {};
    this.#log("stream.started", { pid: child.pid ?? null, target: redactTarget(this.#config) });

    readLines(child.stdout, (line) => {
      const update = parseProgressLine(line);
      if (update) this.#progress = { ...this.#progress, ...update };
    });

    // ffmpeg explains a dropped stream on stderr; a handful of lines is enough to diagnose,
    // and an endless loop of warnings must not flood the log.
    readLines(child.stderr, (line) => {
      if (line === "" || this.#stderrLines >= 20) return;
      this.#stderrLines += 1;
      this.#log("stream.stderr", { line });
    });

    child.on("error", (error) => {
      this.#log("stream.error", { message: error.message });
    });

    child.on("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#log("stream.exited", { code, signal, restarts: this.#restarts });
      if (this.#stopping) return;
      this.#scheduleRestart();
    });
  }

  #scheduleRestart(): void {
    this.#restarts += 1;
    if (this.#restarts > this.#maxRestarts) {
      this.#running = false;
      this.#log("stream.gave_up", { restarts: this.#restarts });
      return;
    }

    const delayMs = Math.min(this.#maxBackoffMs, 1000 * 2 ** (this.#restarts - 1));
    this.#log("stream.restart_in", { ms: delayMs, restarts: this.#restarts });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#stopping) this.#launch();
    }, delayMs);
  }
}
