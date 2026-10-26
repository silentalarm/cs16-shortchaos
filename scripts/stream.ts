import process from "node:process";
import { StreamSupervisor, buildFfmpegArgs, loadStreamConfig, redactTarget } from "../src/stream.ts";

/**
 * Runs (or just prints) the ffmpeg pipeline that pushes the game window to YouTube.
 *
 *   npm run stream                     # push to YouTube using .env
 *   npm run stream -- --print          # show the command, key masked, run nothing
 *   npm run stream -- --duration 20    # smoke test: stop after 20 s
 *
 * `--duration` together with STREAM_OUTPUT writes a local .flv instead of going live, which
 * is how the pipeline is verified without a stream key and without touching the channel.
 */
const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

const config = loadStreamConfig();
const durationSec = Number(option("duration") ?? "");

if (flag("print")) {
  const args = buildFfmpegArgs(config);
  const last = args.length - 1;
  args[last] = redactTarget(config);
  log("stream.command", { source: config.source, target: redactTarget(config), command: [config.ffmpegPath, ...args] });
  process.exit(0);
}

const supervisor = new StreamSupervisor({ config, log });

if (Number.isFinite(durationSec) && durationSec > 0) {
  setTimeout(() => {
    log("stream.duration_reached", { seconds: durationSec });
    void shutdown(0);
  }, durationSec * 1000);
}

const progressTimer = setInterval(() => {
  const progress = supervisor.progress;
  if (progress.frame !== undefined) log("stream.progress", { ...progress });
}, 10_000);
progressTimer.unref();

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(progressTimer);
  await supervisor.stop();
  log("stream.stopped", { restarts: supervisor.restarts, ...supervisor.progress });
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

log("stream.begin", { source: config.source, target: redactTarget(config), kind: config.targetKind });
supervisor.start();

if (Number.isFinite(durationSec) && durationSec > 0) {
  // A supervised stream is supposed to stay up; a timed run exits non-zero when it never
  // produced a single frame, so CI and manual smoke tests can rely on the exit code.
  setTimeout(() => {
    if (supervisor.progress.frame === undefined) {
      log("stream.no_frames", { restarts: supervisor.restarts });
      void shutdown(1);
    }
  }, Math.max(1000, durationSec * 1000 - 500));
}
