// Builds the nemesis' look after the film's Nemesis (Resident Evil: Apocalypse, 2004): a body in a
// long, distressed black leather coat with steel buckles and oversized boots, and the pale silicone
// head the prosthetics team made - staples, a metal grille over the jaw, exposed muscle and blood.
//
//   docker cp <a cs16-hlds container>:/hlds/cstrike/models/player/urban/urban.mdl .tmp-stock/urban.mdl
//   docker cp <the same container>:/hlds/cstrike/models/p_knife.mdl .tmp-stock/p_knife.mdl
//   node infra/models/build/nemesis.mjs            # STOCK_DIR overrides the input directory
//
// Why painted by place and not a re-colour: the coat is *not* "the soldier in red". Every pixel of the
// one picture a CS 1.6 player model wears knows the bone of the point of the body it colours, so the
// skin is painted by what that point is - the spine and the arms wear the coat, the shins wear the
// boots, the head wears the prosthetics - and the stock artist's own folds and seams are read back and
// kept (`skin.mjs`). A re-colour cannot tell a sleeve from a boot; this can.
//
// Why not a body of our own: the engine animates a player model by the model's own sequences on the
// stock 13-bone chain (`Bip01` ... `Bip01 R Hand`, where the weapon hangs), so the hero keeps the
// game's skeleton, bodies, sequences and events and gets a painted look of its own. The stock models
// in the image are read, never modified, and never committed: they are Valve's.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { band, blend, dotted, litBy, lum, partOf } from "./skin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const smak = pathToFileURL(process.env.SMAK_DIR ?? join(repo, "..", "_tools", "smak")).href;
const stockDir = process.env.STOCK_DIR ?? join(repo, ".tmp-stock");

const { paint, reskin, textureOf, rgbaOf, check, png, fbm3 } = await import(`${smak}/src/index.mjs`);

/* The look in the film's own words: distressed black leather, steel hardware, oversized boots, pale
   skin with staples. The values are dark on purpose - the coat is black leather, not grey - and the
   light comes back from `litBy`, which reads it off the stock picture. */
const N = {
  coat: [0.052, 0.046, 0.043],
  coatWorn: [0.155, 0.135, 0.12], // the leather's rubbed edges and highlights
  pants: [0.08, 0.072, 0.066],
  boot: [0.04, 0.038, 0.037],
  steel: [0.62, 0.6, 0.55],
  steelDark: [0.13, 0.13, 0.14],
  skin: [0.62, 0.585, 0.5], // the silicone head: pale, a little green
  skinRaw: [0.46, 0.2, 0.17], // exposed muscle
  muscle: [0.33, 0.08, 0.07],
  blood: [0.18, 0.02, 0.02],
  bloodDry: [0.27, 0.06, 0.04],
};

const POSE = { seq: 1, frame: 0 }; // idle1, frame 0: the pose the model is measured and painted in
const TEX = "SEAL_Working1.BMP"; // the one picture the stock soldier's body wears
const MID = -2.5; // the model's middle line in y (the head sits at -7..2, the hands at -8..8)
const HEM = -21; // the coat's hem, mid-shin: what hangs below it is the boots
const SOLE = -36.4; // where the boots' soles are in the idle pose

/** Leather: the colour at the stock picture's own light, with a sheen on what stands out. */
const leather = (base) => (place) => {
  const gloss = Math.min(1, Math.max(0, (lum(place.blur(1)) / Math.max(lum(place.blur(7)), 0.02) - 1.15) / 0.45));
  return blend(litBy(base, place, 0.5), N.coatWorn, Math.min(1, gloss * 0.45 + (place.n[2] > 0.55 ? 0.12 : 0)));
};

/** The prosthetics: pale silicone, with the raw patches the suit's repairs left open. */
const prosthetics = (place) => {
  const raw = Math.min(1, Math.max(0, (fbm3(place.p, 0.3, 11) - 0.52) / 0.2));
  // A third of the stock light rather than half: the head is a different material from the helmet that
  // was painted there, and the helmet's shading would drag the silicone down to the coat's darkness.
  return blend(litBy(N.skin, place, 0.35), N.skinRaw, raw * 0.45);
};


/* 1. The garment, part by part. The bone is the whole trick: the sleeves are on the arms, the hem on
   the thighs and the shins, and the hands come out of the sleeves pale. */
const cloth = (place) => {
  const part = partOf(place.bone);
  if (part === "head") return prosthetics(place);
  if (part === "neck") return leather(N.coat)(place); // the coat's high collar
  if (part === "hand") return blend(litBy(N.skin, place, 0.4), N.bloodDry, 0.15);
  if (part === "boot") return litBy(N.boot, place, 0.45);
  if (part === "calf") return leather(place.p[2] > HEM ? N.coat : N.boot)(place);
  if (part === "pelvis") return leather(N.pants)(place);
  return leather(N.coat)(place);
};

/* 2. The hardware: two straps across the coat with a steel buckle on the middle line, a strap on each
   thigh, the coat's worn hem, and the boots' steel toes and soles. */
const hardware = ({ p, n, bone, rgb }) => {
  const part = partOf(bone);
  const y = p[1] - MID;

  if (part === "boot") {
    if (Math.abs(p[2] - SOLE) < 0.7) return blend(rgb, N.steelDark, 0.85); // the sole
    if (n[0] > 0.35 && p[2] < SOLE + 5.2) return blend(rgb, N.steel, 0.4); // the toe cap
    return undefined;
  }

  if (part === "torso" || part === "thigh") {
    const strap = Math.max(
      band(p[2], 11.4, 12.8, 0.5),
      band(p[2], 4.4, 5.8, 0.5),
      part === "thigh" ? band(p[2], -9.2, -7.8, 0.5) : 0,
    );
    if (strap > 0) {
      const buckle = Math.abs(y) < 1.5 && n[0] > 0.35;
      return buckle ? blend(rgb, N.steel, 0.85 * strap) : blend(rgb, N.steelDark, 0.8 * strap);
    }
  }

  if (part === "calf" || part === "thigh") {
    const hem = band(p[2], HEM - 0.4, HEM + 0.4, 0.7);
    if (hem > 0) return blend(rgb, N.coatWorn, hem * 0.9);
  }
  return undefined;
};

/* 3. The creature: tubes of bare muscle pushed through the leather (the prosthetics' "grotesque
   piping"). The noise is read in model space, so a tube runs across a texture seam instead of stopping
   at one, and the arms and the skull get the most of it. */
const piping = ({ p, bone, rgb }) => {
  const part = partOf(bone);
  if (part !== "arm" && part !== "torso" && part !== "head") return undefined;
  // Only where the leather is split at all: without the patch the tubes would cover the whole coat and
  // the body would read as a red soldier again, which is the thing this look is here to stop.
  if (fbm3(p, 0.12, 7) < 0.6) return undefined;
  const width = part === "torso" ? 0.022 : 0.03;
  const d = Math.abs(fbm3(p, 0.42, 5) - 0.5);
  if (d > width) return undefined;
  const core = 1 - d / width;
  return blend(blend(rgb, N.muscle, 0.85), [0.55, 0.22, 0.18], core * 0.45);
};

/* 4. The head: the metal grille over the jaw, and staples along a ring round the crown and a line down
   one cheek - the detail the film's prosthetics are known for. */
const head = ({ p, n, bone, rgb }) => {
  if (partOf(bone) !== "head") return undefined;
  const y = p[1] - MID;

  const jaw = band(p[2], 14.4, 17.4, 0.5) * band(Math.abs(y), 0, 3.6, 0.5) * (n[0] > 0.1 ? 1 : 0);
  if (jaw > 0) {
    const bar = dotted(p[2], 0.8, 0.42);
    return blend(rgb, blend(N.steelDark, N.steel, bar), jaw * 0.9);
  }

  const ring = Math.abs(p[2] - 22.4) < 0.45;
  const cheek = Math.abs(y - 2.8) < 0.4 && p[2] > 17 && p[2] < 22.4;
  if (ring || cheek) {
    const staple = dotted(ring ? y * 2.2 : p[2], 1.25, 0.42);
    return staple ? blend(rgb, N.steel, 0.85) : blend(rgb, N.skinRaw, 0.45); // the scar a staple holds shut
  }
  return undefined;
};

/* 5. Blood: soaked into the leather in patches, and four wounds - the one on the chest is where the
   film's Alice puts hers. */
const WOUNDS = [
  [9.4, MID - 2.2, 8.2, 0.55],
  [8.2, MID + 2.6, 1.4, 0.45],
  [4.2, -8.6, 15, 0.5],
  [-6, 3.6, -9, 0.5],
];

const blood = ({ p, bone, rgb }) => {
  if (partOf(bone) === "boot") return undefined;
  let hit = false;
  let colour = rgb;

  const soaked = Math.min(1, Math.max(0, (fbm3(p, 0.55, 29) - 0.68) / 0.1));
  if (soaked > 0) {
    colour = blend(colour, N.blood, soaked * 0.45);
    hit = true;
  }

  for (const [x, y, z, size] of WOUNDS) {
    const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
    if (d > size * 2.4) continue;
    const tear = 1 - Math.min(1, Math.abs(d - size * 1.15) / (size * 0.5));
    colour = blend(colour, [0.03, 0.02, 0.02], 1 - Math.min(1, d / size)); // the hole
    if (tear > 0) colour = blend(colour, N.bloodDry, tear * 0.7); // the torn, dried edge
    hit = true;
  }
  return hit ? colour : undefined;
};

/* The knife keeps its two rules (steel blade, blood-soaked grip): a picture with no body under it has
   nothing to paint by place. */
const KNIFE_RULES = [
  { recolour: [0.3, 0.03, 0.04], sat: [0, 0.5] },
  { light: [0.45, 1], recolour: [0.8, 0.78, 0.75], sat: [0, 0.1] },
];

const outDir = join(repo, "infra", "models", "player", "nemesis");


const source = readFileSync(join(stockDir, "urban.mdl"));
const { mdl, shared } = paint(
  source,
  [cloth, { soft: 2, fn: hardware }, { soft: 2, fn: piping }, { soft: 2, fn: head }, { soft: 2, fn: blood }],
  { pose: POSE, only: [TEX] },
);

// The check is the gate, not a warning (docs/activities/assets.md, rule 2): a model the engine refuses
// precaches to nothing, and the event is silent with the server up.
const report = check(mdl, "goldsrc", { source });
for (const line of [...report.facts, ...report.warnings.map((w) => `WARN ${w}`), ...report.errors.map((e) => `ERROR ${e}`)])
  console.log(`nemesis: ${line}`);
if (report.errors.length) process.exit(1);

mkdirSync(outDir, { recursive: true });
const out = join(outDir, "nemesis.mdl");
writeFileSync(out, mdl);
console.log(`${out} (${mdl.length} bytes)`);
console.log(
  `nemesis: ${Math.round(shared[TEX] * 100)}% of the picture is worn by two places of the body, so a ` +
    `one-sided mark would show twice - the coat is painted symmetric on purpose`,
);

// The painted picture itself, for a human: the build says PASS, not "that looks like the nemesis".
const painted = textureOf(mdl, TEX);
writeFileSync(join(outDir, `nemesis_${TEX.replace(/\.bmp$/i, "")}.png`), png(painted.width, painted.height, rgbaOf(painted)));

const knifeSource = readFileSync(join(stockDir, "p_knife.mdl"));
const knife = reskin(knifeSource, KNIFE_RULES);
const knifeReport = check(knife.mdl, "goldsrc", { source: knifeSource });
for (const line of [...knifeReport.facts, ...knifeReport.errors.map((e) => `ERROR ${e}`)])
  console.log(`p_nemesis_knife: ${line}`);
if (knifeReport.errors.length) process.exit(1);

const knifeOut = join(repo, "infra", "models", "weapons", "p_nemesis_knife.mdl");
mkdirSync(dirname(knifeOut), { recursive: true });
writeFileSync(knifeOut, knife.mdl);
console.log(`${knifeOut} (${knife.mdl.length} bytes), textures repainted: ${knife.changed.join(", ") || "none"}`);
for (const picture of knife.pictures) {
  const file = join(dirname(knifeOut), `p_nemesis_knife_${picture.name.replace(/\.bmp$/i, "")}.png`);
  writeFileSync(file, png(picture.image.width, picture.image.height, picture.image.rgba));
  console.log(`${file} - ${picture.image.width}x${picture.image.height}, the re-skinned picture`);
}

