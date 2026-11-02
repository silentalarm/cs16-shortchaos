import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActivities } from "../src/activities.ts";
import { writeUiFrame } from "../src/ui/loop.ts";
import {
  BAR_BLOCK,
  PANEL_FILES,
  PANEL_LAYOUT,
  barSplit,
  panelLayers,
  topName,
} from "../src/ui/panel.ts";
import { buildUiState, type UiState } from "../src/ui/state.ts";

/**
 * The panel is text the encoder draws with drawtext, so what is pinned here is the content of those
 * files: the bar keeps its width, the frag counts are separate layers over its ends, a nickname
 * cannot damage a line, and the names and sizes are the ones `infra/stream/entrypoint.sh` reads.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));

function state(overrides: Partial<UiState> = {}): UiState {
  const base = buildUiState({
    score: { t: 12, ct: 9, topT: "Mr Smith 7", topCt: "Neo 5" },
    target: { name: "Smith", hp: 87, armor: 42 },
    recent: [],
    catalog,
    now: 0,
  });
  return { ...base, ...overrides };
}

function layer(overrides: Partial<UiState>, file: string): string {
  const found = panelLayers(state(overrides)).find((item) => item.file === file);
  assert.ok(found !== undefined, `no layer ${file}`);
  return found.text;
}

test("the chaos meter is a bar of its own, above the donation line", () => {
  const empty = layer({ chaos: { total: 0, threshold: 1000 } }, PANEL_FILES.chaos);
  assert.match(empty, /^ХАОС /u);
  assert.match(empty, /0\/1000 RUB$/u);

  const half = layer({ chaos: { total: 500, threshold: 1000 } }, PANEL_FILES.chaos);
  assert.ok(half.includes(BAR_BLOCK.repeat(5)), `half a meter is five blocks: ${half}`);
  assert.match(half, /500\/1000 RUB$/u);

  // One rouble before the burst is nine blocks: a full run would promise an effect that is not paid.
  const almost = layer({ chaos: { total: 999, threshold: 1000 } }, PANEL_FILES.chaos);
  assert.equal(almost.includes(BAR_BLOCK.repeat(10)), false, almost);
});

test("the bar splits into a fixed number of blocks", () => {
  assert.deepEqual(barSplit(10, 10), { t: 10, ct: 10 });
  assert.deepEqual(barSplit(20, 0), { t: 20, ct: 0 });
  assert.deepEqual(barSplit(0, 20), { t: 0, ct: 20 });
  // No frags at all: an even bar, not one leaning to a side.
  assert.deepEqual(barSplit(0, 0), { t: 10, ct: 10 });
  // A lead of one frag out of twenty is one block, not zero and not two.
  assert.deepEqual(barSplit(11, 9), { t: 11, ct: 9 });

  for (const [t, ct] of [[0, 0], [1, 0], [7, 3], [100, 1], [3, 3]] as const) {
    const split = barSplit(t, ct);
    assert.equal(split.t + split.ct, 20, `t=${t} ct=${ct} changes the width of the bar`);
  }
});

test("both bar layers hold nothing but full blocks", () => {
  const t = layer({}, PANEL_FILES.barT);
  const ct = layer({}, PANEL_FILES.barCt);

  assert.equal(t.length + ct.length, 20);
  assert.equal(t + ct, BAR_BLOCK.repeat(20), "a gap or a shade character would move the bar");
  assert.doesNotMatch(t + ct, /[^\u2588 ]/u);
});

test("the frag counts are drawn on the bar ends", () => {
  assert.equal(layer({}, PANEL_FILES.scoreT), "12");
  assert.equal(layer({}, PANEL_FILES.scoreCt), "9");

  // No score: the numbers go away with the bar instead of showing two zeros.
  assert.equal(layer({ score: null }, PANEL_FILES.scoreT), "");
  assert.equal(layer({ score: null }, PANEL_FILES.scoreCt), "");

  // Three digits and a zero are still plain text: nothing to escape, nothing to trim.
  const wide = { t: 100, ct: 0, topT: "", topCt: "" };
  assert.equal(layer({ score: wide }, PANEL_FILES.scoreT), "100");
  assert.equal(layer({ score: wide }, PANEL_FILES.scoreCt), "0");
});

test("a side with no frags still writes a file", () => {
  // An empty text file makes drawtext draw nothing; a space keeps the layer honest and the file
  // non-empty, which is what the encoder's file check relies on.
  const score = { t: 0, ct: 12, topT: "", topCt: "Neo 5" };
  assert.equal(layer({ score }, PANEL_FILES.barT), " ");
  assert.equal(layer({ score }, PANEL_FILES.barCt), BAR_BLOCK.repeat(20));
  // No score at all: no bar, instead of a bar that means nothing.
  assert.equal(layer({ score: null }, PANEL_FILES.barT), " ");
  assert.equal(layer({ score: null }, PANEL_FILES.barCt), " ");
});

test("the tops keep the names, the counts live on the bar", () => {
  assert.equal(topName("Mr Smith 7"), "Mr Smith");
  assert.equal(topName("Neo"), "Neo");
  assert.equal(topName("bot 7 12"), "bot 7");
  assert.equal(layer({}, PANEL_FILES.topT), "TOP Mr Smith");
  assert.equal(layer({}, PANEL_FILES.topCt), "TOP Neo");
  // No score: no "TOP" line with an empty name behind it.
  assert.equal(layer({ score: null }, PANEL_FILES.topT), "");
});

test("the bot on camera and the donation lines reach the panel", () => {
  assert.equal(layer({}, PANEL_FILES.target), "Smith 87 HP 42 AR");
  assert.match(layer({}, PANEL_FILES.last), /NO DONATIONS YET/u);
  assert.match(layer({}, PANEL_FILES.next), /^NEXT: /u);
  // A live rotation replaces the price list with the countdown, and both live in the same file.
  assert.equal(
    layer({ next: "ДАЛЬШЕ 2:31 · HE PARTY" }, PANEL_FILES.next),
    "ДАЛЬШЕ 2:31 · HE PARTY",
  );
});

test("the duel winner takes the notice line, ahead of everything else", () => {
  assert.equal(layer({ winner: "Mr Smith" }, PANEL_FILES.notice), "WINNER: Mr Smith");
  // A stale poll must not hide the winner: it is on screen for five seconds before the map changes.
  assert.equal(layer({ winner: "Mr Smith", stale: true }, PANEL_FILES.notice), "WINNER: Mr Smith");
  // No duel decided: the line falls back to what it said before.
  assert.equal(layer({ winner: "" }, PANEL_FILES.notice), "");
  assert.equal(layer({ winner: "", score: null }, PANEL_FILES.notice), "WAITING FOR THE GAME");

  // The line is 24 characters wide at 30 px: a long nickname is cut, not wrapped.
  const long = layer({ winner: "x".repeat(40) }, PANEL_FILES.notice);
  assert.ok(long.length <= 25, `the winner line is ${long.length} chars and would run off the frame`);
  assert.match(long, /^WINNER: x+…$/u);
});

test("a missing score says why instead of drawing zeros", () => {
  assert.equal(layer({ score: null }, PANEL_FILES.notice), "WAITING FOR THE GAME");
  assert.equal(layer({ stale: true }, PANEL_FILES.notice), "NO SIGNAL FROM THE GAME");
  assert.equal(layer({}, PANEL_FILES.notice), "", "a healthy panel draws no notice at all");
});

test("a nickname cannot damage its line", () => {
  // `%` and `\` are expanded by drawtext even inside a file, and control characters would break the
  // line drawing; clean() removes both before anything is written.
  const hostile = layer(
    { target: { name: "a%b\\c\nd\u0000e", hp: 1, armor: 0 } },
    PANEL_FILES.target,
  );
  assert.doesNotMatch(hostile, /[%\\\u0000-\u001f]/u);
  assert.match(hostile, /^abc d e 1 HP 0 AR$/u);

  const long = layer({ target: { name: "x".repeat(80), hp: 1, armor: 0 } }, PANEL_FILES.target);
  assert.ok(long.length <= 31, `the target line is ${long.length} chars and would run off the frame`);
  assert.match(long, /…/u);
});

test("the writer puts one whole file per layer on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-ui-"));
  try {
    const layers = panelLayers(state());
    writeUiFrame(dir, layers, state());

    for (const item of layers) {
      const written = readFileSync(join(dir, "ui", item.file), "utf8");
      // No trailing newline: drawtext would count it as a second, empty line.
      assert.equal(written, item.text, `${item.file} does not match its layer`);
    }
    assert.ok(readFileSync(join(dir, "ui", "ui.json"), "utf8").includes("\"theme\""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bottom donation lines can be switched off on their own", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

  // The switch has to exist in the encoder and be discoverable, or the only way to hide the lines is
  // editing the filter by hand.
  assert.ok(entrypoint.includes('UI_DONATE="${STREAM_UI_DONATE:-1}"'), "no donation switch");
  assert.ok(example.includes("STREAM_UI_DONATE="), "STREAM_UI_DONATE is not documented");
  // And it must actually guard the two layers, not just be read.
  const guarded = entrypoint.slice(entrypoint.indexOf('if [ "$UI_DONATE" = 1 ]'));
  assert.ok(guarded.includes("panel_add last.txt "), "last.txt is drawn regardless of the switch");
  assert.ok(guarded.includes("panel_add next.txt "), "next.txt is drawn regardless of the switch");
});

test("the encoder reads the same file names the control API writes", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");

  for (const file of Object.values(PANEL_FILES)) {
    assert.ok(
      entrypoint.includes(`panel_add ${file} `),
      `no drawtext layer for ${file}; the entrypoint and PANEL_FILES disagree`,
    );
  }
  // Every line has to be re-read, or the panel is a still picture again. The option lives in
  // panel_add(), which is why it appears once in the source and eight times in the filter graph.
  assert.ok(entrypoint.includes(":reload=1"), "drawtext no longer re-reads its text file");
});

test("a text file the encoder has never seen cannot kill the graph", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");

  // The panel grew from eight files to ten: after an upgrade the old control API has not written the
  // new ones yet, and the `ui.json` left in the volume lets the wait pass at once. A drawtext with a
  // missing textfile fails the whole filter graph, so every layer pre-creates its own empty file -
  // an empty file simply draws nothing.
  assert.ok(
    entrypoint.includes('[ -e "$UI_DIR/$1" ] || : 2>/dev/null > "$UI_DIR/$1"'),
    "panel_add no longer pre-creates its text file",
  );
});

test("the encoder no longer rasterises a picture", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");
  const dockerfile = readFileSync(new URL("../infra/stream/Dockerfile", import.meta.url), "utf8");

  // Measured on a live stream: `-loop 1` on a PNG keeps the first decoded frame, and a FIFO of PNG
  // frames showed the same picture for minutes. Both leave a still panel on screen.
  assert.doesNotMatch(entrypoint, /-loop 1 -framerate/u, "the frozen file input is back");
  assert.doesNotMatch(entrypoint, /-f image2pipe/u, "the frozen pipe input is back");
  assert.doesNotMatch(entrypoint, /rsvg-convert/u, "the rasteriser is back, the panel freezes again");
  assert.doesNotMatch(dockerfile, /librsvg2-bin/u, "the rasteriser is still installed");
});

test("the frag counts are drawn over the bar ends, not inside them", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");

  // One inset for both sides, one row: a number grows inward from the fixed outer edge instead of
  // pushing the blocks, and both numbers sit at the same height on the bar.
  assert.ok(entrypoint.includes("score_x=$((UI_MARGIN + 12))"), "the counts lost their inset");
  // Measured on a rendered frame: blocks 36..83, a digit line at 42 covers 42..61, so the counts
  // need to sit 14 px below UI_TOP to share the centre of the bar.
  assert.ok(entrypoint.includes("score_y=$((UI_TOP + 14))"), "the counts lost their row");
  assert.ok(
    entrypoint.includes(
      'panel_add score-t.txt "$UI_SIZE_SCORE" "$UI_COLOR_TEXT" "$score_x" "$score_y"',
    ),
    "score-t.txt is not drawn at the left end of the bar",
  );
  assert.ok(
    entrypoint.includes(
      'panel_add score-ct.txt "$UI_SIZE_SCORE" "$UI_COLOR_TEXT" "w-text_w-${score_x}" "$score_y"',
    ),
    "score-ct.txt is not drawn at the right end of the bar",
  );
});

test("the bar wears the game's colours, and compose agrees with the encoder", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");

  // Red for the terrorists, blue for the counter-terrorists: the colours of the in-game health
  // cross and armour shield, instead of the orange/light-blue pair the first version used.
  const colours: Record<string, string> = {
    STREAM_UI_COLOR_T: "0xDD3333",
    STREAM_UI_COLOR_CT: "0x3366DD",
  };
  for (const [name, value] of Object.entries(colours)) {
    const fallback = `${name}:-${value}}`;
    assert.ok(entrypoint.includes(fallback), `${name} default drifted in the encoder`);
    // The compose file passes its own fallback; a difference there is a colour nobody can predict.
    assert.ok(compose.includes(fallback), `${name} default drifted in docker-compose.yml`);
  }
});

test("the panel and the encoder agree on the geometry", () => {
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");
  const defaults: Record<string, number> = {
    STREAM_UI_SIZE_BAR: PANEL_LAYOUT.barSize,
    STREAM_UI_SIZE_SCORE: PANEL_LAYOUT.scoreSize,
    STREAM_UI_SIZE_TOP: PANEL_LAYOUT.topSize,
    STREAM_UI_SIZE_TARGET: PANEL_LAYOUT.targetSize,
    STREAM_UI_SIZE_LAST: PANEL_LAYOUT.lastSize,
    STREAM_UI_SIZE_NEXT: PANEL_LAYOUT.nextSize,
    STREAM_UI_MARGIN: PANEL_LAYOUT.margin,
    STREAM_UI_TOP: PANEL_LAYOUT.top,
    STREAM_UI_BOTTOM: PANEL_LAYOUT.bottom,
  };

  for (const [name, value] of Object.entries(defaults)) {
    // The shell keeps the fallback in `${NAME:-default}`; the local alias is named differently.
    assert.ok(
      entrypoint.includes(`${name}:-${value}}`),
      `${name} default drifted from PANEL_LAYOUT`,
    );
  }
});
