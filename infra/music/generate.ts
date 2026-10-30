// Renders the event music into a directory, one `<code>.wav` per bed.
//
// Runs in a build stage of the capture image (`infra/stream/Dockerfile`), so the repository keeps no
// audio binaries while every image still ships music. Node 24 executes TypeScript directly, which is
// why this is a `.ts` file and not a script with its own toolchain.
//
//   node infra/music/generate.ts /music
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MUSIC_CODES, MUSIC_SECONDS, renderTrack } from "../../src/music.ts";

const outDir = process.argv[2] ?? ".";
mkdirSync(outDir, { recursive: true });

let written = 0;
for (const code of MUSIC_CODES) {
  const track = renderTrack(code);
  writeFileSync(join(outDir, `${code}.wav`), track);
  written += track.length;
  console.log(`music: ${code}.wav ${(track.length / 1024).toFixed(0)} KiB`);
}

console.log(`music: ${MUSIC_CODES.length} beds, ${MUSIC_SECONDS}s each, ${(written / 1024 / 1024).toFixed(1)} MiB total`);
