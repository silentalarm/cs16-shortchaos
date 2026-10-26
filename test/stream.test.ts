import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  StreamSupervisor,
  buildFfmpegArgs,
  parseProgressLine,
  parseStreamConfig,
  redactTarget,
  type SpawnedProcess,
  type StreamConfig,
} from "../src/stream.ts";

function read(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name];
}

const KEY = "abcd-1234-efgh";

function toRtmp(extra: Record<string, string> = {}): StreamConfig {
  return parseStreamConfig(read({ YOUTUBE_STREAM_KEY: KEY, ...extra }), "win32");
}

function toFile(extra: Record<string, string> = {}): StreamConfig {
  return parseStreamConfig(read({ STREAM_OUTPUT: "out.flv", STREAM_SOURCE: "test", ...extra }), "linux");
}

test("the capture source defaults to the host platform", () => {
  assert.equal(parseStreamConfig(read({ YOUTUBE_STREAM_KEY: KEY }), "win32").source, "desktop");
  assert.equal(parseStreamConfig(read({ YOUTUBE_STREAM_KEY: KEY }), "linux").source, "x11");
});

test("a missing stream key is refused unless we record to a file", () => {
  assert.throws(() => parseStreamConfig(read({}), "linux"), /YOUTUBE_STREAM_KEY must be set/);
  assert.equal(toFile().targetKind, "file");
});

test("the rtmp target is the base url plus the key, and logs mask it", () => {
  const config = toRtmp({ YOUTUBE_RTMP_URL: "rtmp://a.rtmp.youtube.com/live2/" });
  assert.equal(config.target, `rtmp://a.rtmp.youtube.com/live2/${KEY}`);
  assert.equal(redactTarget(config), "rtmp://a.rtmp.youtube.com/live2/***");
});

test("odd frame sizes and silly numbers are refused before ffmpeg sees them", () => {
  assert.throws(() => toRtmp({ STREAM_WIDTH: "1281" }), /must be even/);
  assert.throws(() => toRtmp({ STREAM_FPS: "5" }), /STREAM_FPS/);
  assert.throws(() => toRtmp({ STREAM_BITRATE_KBPS: "100" }), /STREAM_BITRATE_KBPS/);
  assert.throws(() => toRtmp({ STREAM_SOURCE: "webcam" }), /STREAM_SOURCE must be one of/);
});

test("desktop capture grabs the chosen region with gdigrab", () => {
  const args = buildFfmpegArgs(toRtmp({ STREAM_OFFSET_X: "1920" })).join(" ");
  assert.match(args, /-f gdigrab -framerate 30 -offset_x 1920 -offset_y 0 -video_size 1280x720 -i desktop/u);
});

test("x11 capture points at the virtual display", () => {
  const args = buildFfmpegArgs(toFile({ STREAM_SOURCE: "x11", STREAM_DISPLAY: ":99" })).join(" ");
  assert.match(args, /-f x11grab -framerate 30 -video_size 1280x720 -i :99\.0/u);
});

test("the test source needs no display and still produces a real stream", () => {
  const args = buildFfmpegArgs(toFile()).join(" ");
  assert.match(args, /-f lavfi -i testsrc2=size=1280x720:rate=30/u);
  assert.match(args, /-c:v libx264/u);
});

test("keyframes are forced every N seconds so YouTube can cut segments", () => {
  const args = buildFfmpegArgs(toRtmp({ STREAM_FPS: "30", STREAM_KEYFRAME_SEC: "2" })).join(" ");
  assert.match(args, /-g 60 -keyint_min 60 -sc_threshold 0/u);
});

test("both video and audio are mapped, video-only streams look broken on YouTube", () => {
  const args = buildFfmpegArgs(toRtmp()).join(" ");
  assert.match(args, /-map 0:v:0 -map 1:a:0/u);
  assert.match(args, /-c:a aac/u);
});

test("a file target is overwritten, an rtmp target never is", () => {
  assert.match(buildFfmpegArgs(toFile()).join(" "), /-y -f flv out\.flv$/u);
  assert.doesNotMatch(buildFfmpegArgs(toRtmp()).join(" "), /-y /u);
});

test("progress lines are parsed, noise is ignored", () => {
  assert.deepEqual(parseProgressLine("frame=120"), { frame: 120 });
  assert.deepEqual(parseProgressLine("fps=29.97"), { fps: 29.97 });
  assert.deepEqual(parseProgressLine("bitrate=2500.1kbits/s"), { bitrateKbps: 2500.1 });
  assert.equal(parseProgressLine("progress=continue"), null);
  assert.equal(parseProgressLine("garbage"), null);
});

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

function supervisorFor(
  config: StreamConfig,
  children: FakeChild[],
  options: { maxRestarts?: number } = {},
): StreamSupervisor {
  return new StreamSupervisor({
    config,
    log: () => undefined,
    maxBackoffMs: 10,
    killTimeoutMs: 50,
    maxRestarts: options.maxRestarts ?? 3,
    spawnFn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("the supervisor starts ffmpeg and reports progress", async () => {
  const children: FakeChild[] = [];
  const supervisor = supervisorFor(toFile(), children);
  supervisor.start();

  assert.equal(children.length, 1);
  children[0]?.stdout.write("frame=42\nfps=30.0\nbitrate=1800.5kbits/s\n");
  await sleep(20);

  assert.deepEqual(supervisor.progress, { frame: 42, fps: 30, bitrateKbps: 1800.5 });
  await supervisor.stop();
});

test("a crashed ffmpeg is restarted, and repeated crashes eventually give up", async () => {
  const children: FakeChild[] = [];
  const supervisor = supervisorFor(toFile(), children, { maxRestarts: 2 });
  supervisor.start();

  children[0]?.exit(1);
  await sleep(40);
  assert.equal(children.length, 2, "restarted once");

  children[1]?.exit(1);
  await sleep(40);
  assert.equal(children.length, 3, "restarted twice");

  children[2]?.exit(1);
  await sleep(40);
  assert.equal(children.length, 3, "gave up instead of looping");
  assert.equal(supervisor.running, false);
});

test("stop terminates the encoder and suppresses the restart", async () => {
  const children: FakeChild[] = [];
  const supervisor = supervisorFor(toFile(), children);
  supervisor.start();

  await supervisor.stop();
  assert.deepEqual(children[0]?.signals, ["SIGTERM"]);

  await sleep(40);
  assert.equal(children.length, 1, "no restart after stop");
  assert.equal(supervisor.running, false);
});
