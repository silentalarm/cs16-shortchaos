// Builds the survivor's look after Alice in Resident Evil: Apocalypse (2004) - the film the nemesis
// comes from, and the reason the two modes exist side by side: the pale survivor with red-brown hair,
// bare arms, a black top and crossing shoulder holsters against the coated thing with staples.
//
//   docker cp <a cs16-hlds container>:/hlds/cstrike/models/player/leet/leet.mdl .tmp-stock/leet.mdl
//   node infra/models/build/survivor.mjs           # STOCK_DIR overrides the input directory
//
// Why the leet soldier and not the gign one: a helmet and a visor are the one thing a skin cannot paint
// away - a survivor in a helmet is a counter-terrorist. `leet` is the stock body with a bare head, so
// the hair, the face and the sunglasses are painted on a head that is really there, and the sleeves are
// painted to skin, which gives the bare arms the film's costume has.
//
// Same reasoning as `nemesis.mjs` for everything else: the hero keeps the stock skeleton, bodies,
// sequences and the hand bone the weapon hangs on, and the picture is painted *by place* - every pixel
// knows the bone of the point of the body it colours - so the top is not the trousers is not the face.
// The output is a NEW file under `infra/models`; the stock model in the image is read, never modified,
// and never committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { band, blend, litBy, lum, partOf } from "./skin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const smak = pathToFileURL(process.env.SMAK_DIR ?? join(repo, "..", "_tools", "smak")).href;
const stockDir = process.env.STOCK_DIR ?? join(repo, ".tmp-stock");

const { paint, textureOf, rgbaOf, check, png, fbm3 } = await import(`${smak}/src/index.mjs`);

/* Pale skin, red-brown hair, a black tank top and black cargo trousers: the film's survivor, and
   deliberately the opposite of the nemesis' near-black leather - on a small stream frame the two have
   to be tellable apart by silhouette and by the amount of skin. */
const S = {
  skin: [0.78, 0.62, 0.52],
  skinShade: [0.5, 0.34, 0.29],
  hair: [0.21, 0.095, 0.07],
  tank: [0.055, 0.055, 0.065],
  pants: [0.1, 0.1, 0.11],
  boot: [0.045, 0.045, 0.05],
  strap: [0.13, 0.11, 0.09],
  steel: [0.56, 0.55, 0.5],
  red: [0.4, 0.05, 0.05], // the belt: the one red thing she wears
  blood: [0.22, 0.03, 0.03],
  glass: [0.03, 0.04, 0.06],
};

const POSE = { seq: 1, frame: 0 }; // idle1, frame 0: the pose the model is measured and painted in
const TEX = "Arab_dmbase1.bmp"; // the body's picture
const GLASS = "Chrome3.bmp"; // the sunglasses' lenses
const MID = -2; // the model's middle line in y (the head sits at -6..0, the hands at -8..8)
const CUFF = -30; // where the trousers end and the boots begin, in the idle pose

/** Skin: pale, with the hollows the stock shading has left a little darker and warmer. */
const skin = (place) => {
  const pale = litBy(S.skin, place, 0.6);
  const hollow = Math.min(1, Math.max(0, (lum(place.blur(7)) - lum(place.blur(1))) / 0.06));
  return blend(pale, S.skinShade, hollow * 0.5);
};


/* 1. The clothes, part by part: the tank top on the chest, bare arms and hands, the head's hair where
   it faces up and back and skin where it faces forward, cargo trousers, boots from the ankle down. */
const clothes = (place) => {
  const { p, n, bone } = place;
  const part = partOf(bone);
  if (part === "head") {
    const hair = (n[2] > 0.42 && p[2] > 18) || n[0] < -0.15 || p[2] > 22.4;
    return hair ? litBy(S.hair, place, 0.45) : skin(place);
  }
  if (part === "neck" || part === "hand") return skin(place);
  if (part === "boot") return litBy(S.boot, place, 0.45);
  if (part === "calf") return litBy(p[2] > CUFF ? S.pants : S.boot, place, 0.5);
  if (part === "thigh" || part === "pelvis") return litBy(S.pants, place, 0.5);
  if (part === "arm") return skin(place);
  if (part === "torso") return p[2] > 15.4 ? skin(place) : litBy(S.tank, place, 0.45); // bare shoulders
  return litBy(S.tank, place, 0.45);
};

/* 2. The kit: two shoulder holsters crossing on the chest, a dark red belt with a steel buckle, and the
   seams of the cargo pockets. */
const kit = ({ p, n, bone, rgb }) => {
  const part = partOf(bone);
  const y = p[1] - MID;

  if (part === "torso" && p[2] > 6) {
    const left = Math.abs(p[2] - 11.5 - 0.5 * y);
    const right = Math.abs(p[2] - 11.5 + 0.5 * y);
    const strap = 1 - Math.min(left, right) / 0.7;
    if (strap > 0) {
      const buckle = Math.max(left, right) < 0.9 && n[0] > 0.4;
      return buckle ? blend(rgb, S.steel, 0.8 * strap) : blend(rgb, S.strap, 0.85 * strap);
    }
  }

  if (part === "pelvis" || (part === "torso" && p[2] < 1.5)) {
    const belt = band(p[2], -1.4, 0.4, 0.4);
    if (belt > 0) return blend(rgb, Math.abs(y) < 1.2 && n[0] > 0.4 ? S.steel : S.red, 0.9 * belt);
  }

  if (part === "thigh") {
    const seam = band(Math.abs(Math.abs(y) - 2.2), 0, 0.35, 0.3) * band(p[2], -12, -3, 0.5);
    if (seam > 0) return blend(rgb, S.strap, seam * 0.6);
  }
  return undefined;
};

/* 3. What the night did to the clothes: dust on the trousers and boots, and a little blood on the top -
   enough that she reads as "the one who is still standing", not as a mannequin. */
const wear = ({ p, bone, rgb }) => {
  if (partOf(bone) === "boot") return undefined;
  let colour = rgb;
  let hit = false;
  const dirt = Math.min(1, Math.max(0, (fbm3(p, 0.9, 41) - 0.6) / 0.2));
  if (dirt > 0) {
    colour = blend(colour, [0.12, 0.1, 0.08], dirt * 0.35);
    hit = true;
  }
  const spatter = Math.min(1, Math.max(0, (fbm3(p, 0.7, 17) - 0.66) / 0.12));
  if (spatter > 0) {
    colour = blend(colour, S.blood, spatter * 0.4); // 40% of a red is a smear, not a hole
    hit = true;
  }
  return hit ? colour : undefined;
};

/* 4. The sunglasses: a dark lens with one reflection across it, instead of the stock chrome, which reads
   as two white bulbs at stream scale. */
const glass = ({ u, v }) => {
  const sheen = Math.max(0, 1 - Math.abs(u - v * 0.6 - 12) / 26);
  return blend(S.glass, [0.34, 0.4, 0.46], sheen * 0.5);
};

const outDir = join(repo, "infra", "models", "player", "survivor");
const source = readFileSync(join(stockDir, "leet.mdl"));
const { mdl, shared } = paint(
  source,
  [clothes, { soft: 2, fn: kit }, { soft: 2, fn: wear }, { fn: glass, only: [GLASS] }],
  { pose: POSE, only: [TEX] },
);

// The check is the gate, not a warning (docs/activities/assets.md, rule 2): a model the engine refuses
// precaches to nothing, and the event is silent with the server up.
const report = check(mdl, "goldsrc", { source });
for (const line of [...report.facts, ...report.warnings.map((w) => `WARN ${w}`), ...report.errors.map((e) => `ERROR ${e}`)])
  console.log(`survivor: ${line}`);
if (report.errors.length) process.exit(1);

mkdirSync(outDir, { recursive: true });
const out = join(outDir, "survivor.mdl");
writeFileSync(out, mdl);
console.log(`${out} (${mdl.length} bytes)`);
console.log(
  `survivor: ${Math.round(shared[TEX] * 100)}% of the picture is worn by two places of the body, so the ` +
    `holsters and the pockets are painted symmetric - one strap cannot be one-sided`,
);

// The painted picture itself, for a human: the build says PASS, not "that looks like a survivor".
const painted = textureOf(mdl, TEX);
writeFileSync(join(outDir, `survivor_${TEX.replace(/\.bmp$/i, "")}.png`), png(painted.width, painted.height, rgbaOf(painted)));

