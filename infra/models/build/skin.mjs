// The decisions both hero looks share: which bone is which garment, the light the stock artist
// painted, and the small marks (wear, straps, staples) that are drawn in model space.
//
// A CS 1.6 player model is a skeleton and one 512x512 picture: every pixel of that picture knows the
// bone of the point of the body it colours, so a look is painted *by place* - "the coat is what the
// spine, the arms and the thighs wear" - instead of by repainting the whole sheet one colour. The
// shading that is already there (folds, seams, the buckles the stock artist drew) is kept by painting
// through it: `litBy` gives a pixel the new colour at the brightness the old one had, next to its
// neighbours, so a crease stays a crease.
//
// Nothing here draws a design: the two designs are `nemesis.mjs` and `survivor.mjs`.

/** 0 to 1, whatever came in. */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The brightness of a colour, 0 to 1. */
export const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/** `t` of the way from colour `a` to colour `b`. */
export const blend = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 1 inside `lo..hi`, fading out over `feather` units on either side: a strap, a hem, a belt. */
export const band = (v, lo, hi, feather = 0.6) => {
  if (v < lo - feather || v > hi + feather) return 0;
  if (v >= lo && v <= hi) return 1;
  return clamp01(v < lo ? 1 - (lo - v) / feather : 1 - (v - hi) / feather);
};

/** 1 on each mark: `gap` units apart along `t`, `share` of each one painted. Staples, stitching, bars. */
export const dotted = (t, gap, share = 0.45) => {
  const f = t / gap - Math.floor(t / gap);
  return f < share ? 1 : 0;
};

/**
 * The colour `base` at the brightness the picture has here, relative to its own neighbourhood: a fold
 * the stock artist drew stays a fold, and a repaint does not flatten the body into one flat colour.
 * `amount` is how much of the shading is kept (0.5: from 0.75x to 1.25x of `base`).
 */
export const litBy = (base, place, amount = 0.5) => {
  const fine = lum(place.blur(1));
  const broad = lum(place.blur(9));
  const k = Math.min(1.7, Math.max(0.4, fine / Math.max(broad, 0.02)));
  return base.map((c) => clamp01(c * (1 - amount + amount * k)));
};

/**
 * The part of the body a bone carries, by the names the game's biped uses (`Bip01 L Forearm`,
 * `-- R wrist`, `Bone01`). The bone is what `paint` hands every pixel, so this is what turns "a dark
 * coat" into "a coat, with pale hands coming out of the sleeves".
 */
const PARTS = [
  [/^(head|bone\d+)$/i, "head"],
  [/neck/i, "neck"],
  [/(finger|hand|knuckle)/i, "hand"],
  [/(wrist|upperarm|forearm|bicep|elbow|shoulder)/i, "arm"],
  [/(clavicle|spine|torso)/i, "torso"],
  [/(pelvis|butt)/i, "pelvis"],
  [/(thigh|knee)/i, "thigh"],
  [/(calf|ankle)/i, "calf"],
  [/(foot|toe)/i, "boot"],
];

export const partOf = (bone) => {
  const name = String(bone ?? "").replace(/^--\s*/, "").replace(/^Bip01\s+/i, "");
  for (const [pattern, part] of PARTS) if (pattern.test(name)) return part;
  return "other";
};
