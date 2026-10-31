import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The models this server makes for itself (`docs/activities/assets.md`, "Our own bazooka"). They are
 * committed rather than built, so a broken generator output can reach the image only through a commit -
 * which is exactly what these lines are here to stop: a file that is not a version 10 studio model
 * precaches to nothing and leaves the event silent, and nothing in the game log says why.
 */
const weapons = ["p_bazooka.mdl", "w_bazooka.mdl"] as const;
const load = (name: string): Buffer => readFileSync(new URL(`../infra/models/weapons/${name}`, import.meta.url));

test("the bazooka models are GoldSrc studio models, version 10", () => {
  for (const name of weapons) {
    const mdl = load(name);
    assert.equal(mdl.toString("latin1", 0, 4), "IDST", `${name} is not a studio model`);
    assert.equal(mdl.readInt32LE(4), 10, `${name} is not version 10`);
    // One texture inside each: half a megabyte would be a 1024x512 picture, which the engine shrinks to
    // gl_max_size anyway (smak's own warning, docs/activities/assets.md).
    assert.ok(mdl.length < 256 * 1024, `${name} is ${mdl.length} bytes`);
  }
});

test("each bazooka model carries its own texture and its still animation", () => {
  for (const name of weapons) {
    const text = load(name).toString("latin1");
    assert.match(text, /bazooka_skin\.bmp/, `${name} has no baked texture`);
    assert.match(text, /idle/, `${name} has no idle animation`);
  }
});

test("the image copies the weapon models flat into cstrike/models", () => {
  const dockerfile = readFileSync(new URL("../infra/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY infra\/models\/weapons\/ \/hlds\/cstrike\/models\//);
});

/**
 * The launcher in the hand (the "bazooka is at the bot's feet" report). The player model is the stock rifle
 * with our mesh swapped into it, because a hand-written bone table loses the placement: `buildMdl` stores
 * every corner in the space of its bone, so the offset that was supposed to lift the piece into the hand was
 * subtracted back out - the rebuilt file was byte-identical and the launcher never moved.
 */
test("the launcher is carried by the stock rifle, not by a bone table of our own", () => {
  const builder = readFileSync(new URL("../infra/models/build/bazooka.mjs", import.meta.url), "utf8");
  assert.match(builder, /swapMesh\(source, \{/, "the player model is built from a bone table again");
  assert.match(builder, /piece: \{ tris: piece\.tris, haft: piece\.haft \}/, "the piece is not anchored by its grip");
  assert.match(builder, /size: "own"/, "the launcher is stretched to the rifle's length");
  assert.match(builder, /turn: "as drawn"/, "the piece is turned away from its own axes");
  assert.doesNotMatch(builder, /inHand|const HAND =/, "the old hand offset is back, and it is a no-op");

  // And the file itself carries the stock chain, with the mesh on the bone that carries an AK.
  const text = load("p_bazooka.mdl").toString("latin1");
  assert.match(text, /Bip01 R Hand/, "the player model lost the stock bone chain");
  assert.match(text, /Line02/, "the mesh is not on the bone that carries the rifle");
});

/**
 * Where the piece ends up, in numbers. A studio model stores every corner in the space of the bone that
 * carries it, so the box of the vertices *as they sit in the file* is the placement the engine will draw -
 * the box the modeller had in mind does not survive the write. Valve's `p_ak47.mdl` keeps its rifle in
 * -1.2..1.3 x, -0.9..11.4 y, -7.8..28.8 z of `Line02` (measured with `smak info` on the game's own file),
 * and our piece is swapped into that same model, so it has to land in the same neighbourhood. A piece that
 * was left in model space instead - the "launcher at the bot's feet" bug - sits around x -58, z 51 and drags
 * this box with it, which is the failure these lines are here to catch before it reaches the image.
 */
const bonesOf = (mdl: Buffer): string[] =>
  Array.from({ length: mdl.readInt32LE(140) }, (_, i) => {
    const at = mdl.readInt32LE(144) + i * 112;
    return mdl.toString("latin1", at, at + 32).split("\0")[0] ?? "";
  });

/** Every vertex of every submodel, as the file stores it: its position and the bone it hangs on. */
const verticesOf = (mdl: Buffer): { bone: number; p: [number, number, number] }[] => {
  const points: { bone: number; p: [number, number, number] }[] = [];
  const parts = mdl.readInt32LE(208);
  for (let part = 0; part < mdl.readInt32LE(204); part++) {
    const bodypart = parts + part * 76;
    const models = mdl.readInt32LE(bodypart + 72);
    for (let model = 0; model < mdl.readInt32LE(bodypart + 64); model++) {
      const submodel = models + model * 112;
      const count = mdl.readInt32LE(submodel + 80);
      const bones = mdl.readInt32LE(submodel + 84);
      const verts = mdl.readInt32LE(submodel + 88);
      for (let v = 0; v < count; v++)
        points.push({
          bone: mdl.readUInt8(bones + v),
          p: [mdl.readFloatLE(verts + v * 12), mdl.readFloatLE(verts + v * 12 + 4), mdl.readFloatLE(verts + v * 12 + 8)],
        });
    }
  }
  return points;
};

test("the launcher's vertices sit in the rifle's box on the rifle's bone", () => {
  const mdl = load("p_bazooka.mdl");
  const bone = bonesOf(mdl).indexOf("Line02");
  assert.ok(bone >= 0, "p_bazooka.mdl has no Line02, the bone the rifle is carried on");

  const points = verticesOf(mdl);
  assert.ok(points.length > 100, `p_bazooka.mdl has ${points.length} vertices - that is not a launcher`);

  const elsewhere = [...new Set(points.map((point) => point.bone))].filter((b) => b !== bone);
  assert.deepEqual(elsewhere, [], `the piece hangs on bones ${elsewhere.join(", ")} as well as Line02`);

  // The rifle's box with the room a 42-unit launcher needs: longer than an AK along the barrel, no wider.
  const rifle = [
    [-1.2, 1.3],
    [-0.9, 11.4],
    [-7.8, 28.8],
  ] as const;
  const room = 8;
  const axes = ["x (across)", "y (up)", "z (along the barrel)"] as const;
  for (const axis of [0, 1, 2] as const) {
    const low = Math.min(...points.map((point) => point.p[axis]));
    const high = Math.max(...points.map((point) => point.p[axis]));
    const [rifleLow, rifleHigh] = rifle[axis];
    assert.ok(
      low >= rifleLow - room && high <= rifleHigh + room,
      `the launcher spans ${axes[axis]} ${low.toFixed(1)}..${high.toFixed(1)}, the rifle ${rifleLow}..${rifleHigh}: it is not in the hand`,
    );
    assert.ok(high - low > 0.5, `the launcher is flat on ${axes[axis]}`);
  }
});

/**
 * The nemesis look (`infra/models/build/nemesis.mjs`): a re-skin of the stock soldier and of the stock knife,
 * written as new files. What can be checked without the game is that both are studio models the engine will
 * load and that the player model still carries the game's own skeleton and sequences - a re-skin that lost
 * them would be a frozen statue, which is exactly the failure the re-skin exists to avoid.
 */
const nemesis = readFileSync(new URL("../infra/models/player/nemesis/nemesis.mdl", import.meta.url));
const nemesisKnife = readFileSync(new URL("../infra/models/weapons/p_nemesis_knife.mdl", import.meta.url));

test("the nemesis model is a studio model with the stock skeleton and sequences", () => {
  for (const [name, mdl] of [["nemesis.mdl", nemesis], ["p_nemesis_knife.mdl", nemesisKnife]] as const) {
    assert.equal(mdl.toString("latin1", 0, 4), "IDST", `${name} is not a studio model`);
    assert.equal(mdl.readInt32LE(4), 10, `${name} is not version 10`);
  }

  const text = nemesis.toString("latin1");
  // The 13-bone chain the engine hangs the weapon on, and the animation set that makes a walk a walk.
  assert.match(text, /Bip01 R Hand/, "the nemesis model lost the hand bone the weapon attaches to");
  assert.match(text, /walk/i, "the nemesis model has no walk sequence");
  assert.ok(nemesis.length > 1024 * 1024, `nemesis.mdl is ${nemesis.length} bytes - that is not a rigged body`);
  assert.match(nemesisKnife.toString("latin1"), /pknifeskin\.bmp/, "the nemesis knife lost its skin");
});

test("the image and the entrypoint both carry the player model folder", () => {
  const dockerfile = readFileSync(new URL("../infra/Dockerfile", import.meta.url), "utf8");
  const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY infra\/models\/player\/ \/hlds\/cstrike\/models\/player\//, "the player model is not copied into the image");
  assert.match(dockerfile, /\/opt\/defaults\/models\/player\/nemesis/, "the volume never receives the player model");
  assert.match(entrypoint, /DEFAULTS\/models\/player/, "the entrypoint does not sync player/ into the volume");
});

/**
 * The survivor (`infra/models/build/survivor.mjs`): the same re-skin as the nemesis, off a different stock
 * soldier, so the two hero modes cannot be mistaken for each other on a small frame. The engine animates a
 * player model by the sequences inside the file, so what has to survive the repaint is the skeleton, the walk
 * and the hand the weapon hangs on - a re-skin that lost them is a statue.
 */
const survivorModel = readFileSync(new URL("../infra/models/player/survivor/survivor.mdl", import.meta.url));

test("the survivor model is a rigged studio model of its own", () => {
  assert.equal(survivorModel.toString("latin1", 0, 4), "IDST", "survivor.mdl is not a studio model");
  assert.equal(survivorModel.readInt32LE(4), 10, "survivor.mdl is not version 10");

  const text = survivorModel.toString("latin1");
  assert.match(text, /Bip01 R Hand/, "the survivor lost the hand bone the weapon attaches to");
  assert.match(text, /walk/i, "the survivor has no walk sequence");
  assert.ok(survivorModel.length > 1024 * 1024, `survivor.mdl is ${survivorModel.length} bytes - that is not a rigged body`);
  assert.equal(survivorModel.equals(nemesis), false, "the survivor is the nemesis file under another name");
});

test("the image carries the survivor and both hero looks reach the volume", () => {
  const dockerfile = readFileSync(new URL("../infra/Dockerfile", import.meta.url), "utf8");
  const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY --from=build[^\n]*\/opt\/defaults\/models\/player\/survivor/, "the survivor never reaches the volume defaults");
  assert.match(dockerfile, /\/hlds\/cstrike\/sound\//, "the freeze sound is not copied into the game image");
  assert.match(entrypoint, /DEFAULTS\/sound/, "the entrypoint does not sync sound/ into the volume");
});

/**
 * The hero looks are **painted by place**, not re-coloured (`infra/models/build/{nemesis,survivor,skin}.mjs`).
 * The report was "only the colours changed": a re-colour repaints the whole sheet with one palette and cannot
 * tell a sleeve from a boot. The paint is handed the bone of the point of each pixel's body, so the contract
 * that matters is that the builders go through `partOf`/`litBy` - a builder that is back on `reskin` with one
 * palette per body is the bug this test exists for, and it is invisible in the `.mdl` until somebody looks.
 */
test("the hero skins are painted by place, not re-coloured", () => {
  const skin = readFileSync(new URL("../infra/models/build/skin.mjs", import.meta.url), "utf8");
  assert.match(skin, /export const partOf/, "nothing turns a bone into the garment it carries");
  assert.match(skin, /export const litBy/, "the stock picture's own light is not read back");
  assert.match(skin, /export const band/, "the marks in model space are gone");

  for (const name of ["nemesis", "survivor"] as const) {
    const builder = readFileSync(new URL(`../infra/models/build/${name}.mjs`, import.meta.url), "utf8");
    assert.match(builder, /paint\(/, `${name} is not painted`);
    assert.match(builder, /partOf\(/, `${name} does not paint by bone`);
    assert.match(builder, /litBy\(/, `${name} paints over the stock shading instead of through it`);
    assert.doesNotMatch(builder, /BODY_RULES/, `${name} is one palette for the whole body again`);
  }

  // The film's survivor needs a bare head: a helmet and a visor cannot be painted into hair and a face.
  const survivor = readFileSync(new URL("../infra/models/build/survivor.mjs", import.meta.url), "utf8");
  assert.match(survivor, /leet\.mdl/, "the survivor is built on a helmeted body again");
});

test("the freeze sound is rendered at build time, not committed", () => {
  const dockerfile = readFileSync(new URL("../infra/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS sounds/, "the sound stage is gone");
  assert.match(dockerfile, /node infra\/sounds\/generate\.ts \/sound/, "the stage renders nothing");
  assert.match(dockerfile, /COPY --from=sounds \/sound\/ \/hlds\/cstrike\/sound\//, "the rendered sample never reaches cstrike/sound");
});
