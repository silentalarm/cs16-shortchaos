// Renders the game sounds into a directory, at the paths the plugin precaches
// (`SOUND_FILES`: `freeze/ice_crack.wav` -> `<dir>/freeze/ice_crack.wav`).
//
// Runs in a build stage of the game image (`infra/Dockerfile`), so the repository keeps no audio binary
// while every image still ships the sound. Node 24 executes TypeScript directly, which is why this is a
// `.ts` file and not a script with its own toolchain.
//
//   node infra/sounds/generate.ts /sound
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderSound, SOUND_CODES, SOUND_FILES } from "../../src/sound.ts";

const outDir = process.argv[2] ?? ".";
let written = 0;
let bytes = 0;

for (const code of SOUND_CODES) {
  const sound = renderSound(code);
  const path = join(outDir, SOUND_FILES[code]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sound);
  written += 1;
  bytes += sound.length;
  console.log(`sound: ${SOUND_FILES[code]} ${(sound.length / 1024).toFixed(0)} KiB`);
}

console.log(`sound: ${written} sample(s), ${(bytes / 1024).toFixed(0)} KiB total into ${outDir}`);
