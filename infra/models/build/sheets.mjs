// Draws the two hero looks so a person can look at them: six views of each, a big front and side, the
// heads close up, and all three bodies to one scale (the stock soldier the nemesis is built on, the
// nemesis, the survivor) so "it is a costume now" can be judged, not just assumed.
//
//   docker cp <a cs16-hlds container>:/hlds/cstrike/models/player/urban/urban.mdl .tmp-stock/urban.mdl
//   node infra/models/build/sheets.mjs            # PICTURES_DIR writes them elsewhere
//
// The build scripts only say PASS - the engine will load the file - so these pictures are the check that
// cannot be automated: they are written next to the models, and are meant to be looked at before the
// image is built.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const smak = pathToFileURL(process.env.SMAK_DIR ?? join(repo, "..", "_tools", "smak")).href;
const stockDir = process.env.STOCK_DIR ?? join(repo, ".tmp-stock");

const { sheet, render, lineup, png } = await import(`${smak}/src/index.mjs`);

const POSE = { seq: 1, frame: 0 }; // idle1: the game's own standing pose, the one the skins were painted in
const out = process.env.PICTURES_DIR ?? join(repo, "infra", "models", "player");

const write = (file, image) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png(image.width, image.height, image.rgba));
  console.log(`${file} - ${image.width}x${image.height}`);
};

const looks = [
  { name: "nemesis", dir: join(out, "nemesis"), head: [12, -2.5, 20] },
  { name: "survivor", dir: join(out, "survivor"), head: [11, -2, 19] },
];

for (const look of looks) {
  const mdl = readFileSync(join(look.dir, `${look.name}.mdl`));
  write(join(look.dir, `${look.name}_sheet.png`), sheet(mdl, { size: 300, seq: POSE.seq }));
  write(join(look.dir, `${look.name}_front.png`), render(mdl, { view: "front", width: 560, height: 840, seq: POSE.seq }));
  write(join(look.dir, `${look.name}_side.png`), render(mdl, { view: "side", width: 560, height: 840, seq: POSE.seq }));
  // The head, close up: staples, hair and sunglasses are the parts a whole-body picture cannot show.
  write(
    join(look.dir, `${look.name}_head.png`),
    render(mdl, { view: "front", width: 480, height: 480, seq: POSE.seq, target: look.head, zoom: 4 }),
  );
}

// All three to one scale: what the viewer sees on the stream, where a bot in urban is the yardstick.
const stock = join(stockDir, "urban.mdl");
if (existsSync(stock)) {
  const cast = lineup(
    [
      ["urban (stock)", readFileSync(stock)],
      ["nemesis", readFileSync(join(out, "nemesis", "nemesis.mdl"))],
      ["survivor", readFileSync(join(out, "survivor", "survivor.mdl"))],
    ],
    { yaws: [0, 200], width: 380, height: 620, seq: POSE.seq },
  );
  write(join(out, "nemesis", "nemesis_vs_stock_urban.png"), cast);
} else {
  console.log(`${stock} is not there - the stock soldier is not in the line-up (see nemesis.mjs's header)`);
}
