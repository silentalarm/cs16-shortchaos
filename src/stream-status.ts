import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Telemetry the capture container writes into the shared volume:
 *   status.json   - the layout and target of the current run, written once at start;
 *   runtime.json  - heartbeat of infra/stream/watchdog.sh: client alive, log silence, frozen picture;
 *   progress.txt  - ffmpeg's own output, kept for compatibility (the encoder writes it once).
 *
 * The panel shows the age of the heartbeat, because "ffmpeg is running" and "the picture moves" are
 * different facts: a stuck grabber keeps the process alive and the stream dead, and a client sitting
 * in its menu feeds a perfectly healthy encoder a static image.
 */
export interface StreamLayout {
  kind: string;
  label: string;
  width: number;
  height: number;
  captureWidth: number;
  captureHeight: number;
  fps: number;
  bitrateKbps: number;
  recordSec: number;
  audio: boolean;
  startedAt: string;
}

/** What the watchdog reports every CHECK_SEC (15 s by default). */
export interface StreamRuntime {
  /** Epoch seconds of the write. */
  ts: number;
  xashAlive: boolean;
  /** Seconds since the client last printed anything; null when its log is missing. */
  logAgeSec: number | null;
  /** true when a freezedetect sample found no movement at all; null when it was not sampled. */
  frozen: boolean | null;
  /** How many times the watchdog restarted the client in this run. */
  restarts: number;
}

export type StreamVerdict = "live" | "frozen" | "stalled" | "offline" | "unknown";

export interface StreamProgress {
  frame?: number;
  fps?: number;
  bitrate?: string;
  totalSize?: number;
  dropFrames?: number;
  dupFrames?: number;
  speed?: string;
  outTimeSec?: number;
}

export interface StreamHealth {
  /** false when status.json is missing: the stream container has never run in this volume. */
  configured: boolean;
  /** true when the heartbeat (or, without one, progress.txt) has not been updated in time. */
  stale: boolean;
  /** Seconds since the heartbeat, or since the last progress update when no heartbeat exists. */
  ageSec: number | null;
  layout: StreamLayout | null;
  progress: StreamProgress | null;
  runtime: StreamRuntime | null;
  /** One word for the badges: live, frozen, stalled, offline or unknown. */
  verdict: StreamVerdict;
  error: string | null;
}

export const STALE_AFTER_SEC = 15;
/** The watchdog writes every 15 s, so three missed writes mean the container side is gone. */
export const HEARTBEAT_STALE_AFTER_SEC = 45;

function toNumber(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Two formats are accepted, because the encoder writes the second one:
 *   - `-progress` blocks: one `key=value` per line ("frame=240");
 *   - ffmpeg's stats line: many `key=value` tokens on one line
 *     ("frame=360 fps=30 q=23.0 Lsize=3274KiB time=00:00:12.16 bitrate=2204.4kbits/s dup=0 drop=4 speed=1.01x").
 * Tokenising by whitespace covers both, and the last occurrence of each key wins.
 */
export function parseProgress(text: string): StreamProgress | null {
  const progress: StreamProgress = {};
  let seenAny = false;

  for (const token of text.replace(/=\s+/g, "=").split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (value === "" || value === "N/A") continue;

    switch (key) {
      case "frame": {
        const parsed = toNumber(value);
        if (parsed !== null) { progress.frame = parsed; seenAny = true; }
        break;
      }
      case "fps": {
        const parsed = toNumber(value);
        if (parsed !== null) { progress.fps = parsed; seenAny = true; }
        break;
      }
      case "bitrate":
        progress.bitrate = value;
        seenAny = true;
        break;
      case "total_size": {
        const parsed = toNumber(value);
        if (parsed !== null) progress.totalSize = parsed;
        break;
      }
      case "drop_frames":
      case "drop": {
        const parsed = toNumber(value);
        if (parsed !== null) progress.dropFrames = parsed;
        break;
      }
      case "dup_frames":
      case "dup": {
        const parsed = toNumber(value);
        if (parsed !== null) progress.dupFrames = parsed;
        break;
      }
      case "speed":
        progress.speed = value;
        break;
      case "out_time_us": {
        // ffmpeg's `out_time_ms` is microseconds too; `out_time_us` is the honest spelling.
        const parsed = toNumber(value);
        if (parsed !== null) progress.outTimeSec = Math.round(parsed / 1e5) / 10;
        break;
      }
      case "time": {
        const parsed = parseClock(value);
        if (parsed !== null) progress.outTimeSec = parsed;
        break;
      }
      default:
        break;
    }
  }

  return seenAny ? progress : null;
}

/** HH:MM:SS.ss from the stats line, in seconds. */
function parseClock(value: string): number | null {
  const match = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseLayout(text: string): StreamLayout | null {
  try {
    const raw = JSON.parse(text) as Partial<StreamLayout>;
    if (typeof raw.width !== "number" || typeof raw.height !== "number") return null;
    return {
      kind: typeof raw.kind === "string" ? raw.kind : "unknown",
      label: typeof raw.label === "string" ? raw.label : "",
      width: raw.width,
      height: raw.height,
      captureWidth: typeof raw.captureWidth === "number" ? raw.captureWidth : raw.width,
      captureHeight: typeof raw.captureHeight === "number" ? raw.captureHeight : raw.height,
      fps: typeof raw.fps === "number" ? raw.fps : 0,
      bitrateKbps: typeof raw.bitrateKbps === "number" ? raw.bitrateKbps : 0,
      recordSec: typeof raw.recordSec === "number" ? raw.recordSec : 0,
      audio: raw.audio === true,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    };
  } catch {
    return null;
  }
}

function parseRuntime(text: string): StreamRuntime | null {
  try {
    const raw = JSON.parse(text) as Partial<StreamRuntime>;
    if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return null;
    return {
      ts: raw.ts,
      xashAlive: raw.xashAlive === true,
      logAgeSec: typeof raw.logAgeSec === "number" ? raw.logAgeSec : null,
      frozen: typeof raw.frozen === "boolean" ? raw.frozen : null,
      restarts: typeof raw.restarts === "number" ? raw.restarts : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The verdict is deliberately one word, because the panel has to distinguish three failures that
 * all look like "the stream hangs": the capture container is not running at all (stalled), the
 * client is on the server but nothing on screen moves (frozen - a menu or a dead observer target),
 * and everything works (live).
 */
function verdictOf(configured: boolean, stale: boolean, runtime: StreamRuntime | null): StreamVerdict {
  if (!configured) return "offline";
  if (stale) return "stalled";
  if (runtime === null) return "unknown";
  if (runtime.frozen === true) return "frozen";
  if (runtime.frozen === false) return "live";
  return "unknown";
}

export function readStreamHealth(dir: string, now = Date.now()): StreamHealth {
  const statusPath = join(dir, "status.json");
  const progressPath = join(dir, "progress.txt");
  const runtimePath = join(dir, "runtime.json");

  let layoutText: string;
  try {
    layoutText = readFileSync(statusPath, "utf8");
  } catch {
    return {
      configured: false,
      stale: false,
      ageSec: null,
      layout: null,
      progress: null,
      runtime: null,
      verdict: "offline",
      error: null,
    };
  }

  const layout = parseLayout(layoutText);
  let progress: StreamProgress | null = null;
  let progressAge: number | null = null;
  const error: string | null = layout === null ? "status.json is not readable JSON" : null;

  try {
    progress = parseProgress(readFileSync(progressPath, "utf8"));
    progressAge = Math.max(0, Math.round((now - statSync(progressPath).mtimeMs) / 1000));
  } catch {
    // No progress file yet: the encoder has not started. That is not an error on its own.
  }

  // The heartbeat is the authoritative liveness signal when it exists; progress.txt is only a
  // fallback for an older capture container that does not write one.
  let runtime: StreamRuntime | null = null;
  try {
    runtime = parseRuntime(readFileSync(runtimePath, "utf8"));
  } catch {
    // No watchdog in this volume.
  }

  const ageSec = runtime === null ? progressAge : Math.max(0, Math.round(now / 1000 - runtime.ts));
  const stale = runtime === null
    ? ageSec !== null && ageSec > STALE_AFTER_SEC
    : ageSec !== null && ageSec > HEARTBEAT_STALE_AFTER_SEC;

  return { configured: true, stale, ageSec, layout, progress, runtime, verdict: verdictOf(true, stale, runtime), error };
}

/**
 * Pulls the machine-readable fields out of `donation_events status: active=... queued=... nick=...`.
 *
 * `active` is a '+'-joined list since several paid effects run at the same time: `active` keeps the
 * first code so an older panel still shows something, and `actives` carries the whole list. An older
 * plugin answers something else; then everything stays null and the raw reply is shown.
 */
export interface PluginStatus {
  active: string | null;
  /** Every code whose clock is still armed, in the order the plugin reports them. */
  actives: string[];
  queued: number | null;
  nick: string | null;
  raw: string;
}

export function parsePluginStatus(reply: string): PluginStatus {
  const active = /active=([A-Za-z0-9_+]+)/.exec(reply);
  const queued = /queued=(\d+)/.exec(reply);
  const nick = /nick=([^\s]+)/.exec(reply);
  const activeValue = active?.[1];
  const nickValue = nick?.[1];
  const actives = activeValue === undefined || activeValue === "none"
    ? []
    : activeValue.split("+").filter((code) => code !== "");
  return {
    active: actives[0] ?? null,
    actives,
    queued: queued?.[1] === undefined ? null : Number.parseInt(queued[1], 10),
    nick: nickValue === undefined || nickValue === "none" ? null : nickValue,
    raw: reply.trim(),
  };
}

/**
 * `map_duel status: state=<idle|live|done> winner=<name|->`: the last minute of the map.
 *
 * `live` is the only value the free rotation acts on - it means the two finalists are fighting and
 * nothing else may touch the field. An unreadable or missing answer stays null, which reads as "no
 * duel", so a control API without RCON keeps the rotation running instead of freezing it.
 */
export type DuelState = "idle" | "live" | "done";

export function parseDuelState(reply: string): DuelState | null {
  const state = /state=(idle|live|done)/i.exec(reply)?.[1]?.toLowerCase();
  return state === "idle" || state === "live" || state === "done" ? state : null;
}

/**
 * Activity codes out of `donation_events codes: a,b,c`.
 *
 * Splitting the whole reply on whitespace and commas (the first version) put the plugin name and the
 * `codes:` label into the "supported" set: a code that merely looked like a header word counted as
 * supported, and an empty answer from a server without the plugin still produced two tokens. Only
 * the list after the label counts here, and only tokens shaped like a code survive.
 */
export function parsePluginCodes(reply: string): string[] {
  // The plugin prints the list in chunks of ~100 characters, one line each, because a single long
  // line arrives truncated (the tail of the registry used to disappear and the panel then reported
  // events as missing from a plugin that had them). Every `codes:` segment counts, not just the first.
  const codes: string[] = [];
  for (const segment of reply.matchAll(/codes:([^\r\n]*)/giu)) {
    for (const token of (segment[1] ?? "").split(/[\s,]+/u)) {
      if (/^[a-z][a-z0-9_]{2,31}$/u.test(token)) codes.push(token);
    }
  }
  return [...new Set(codes)];
}
