import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadActivities } from "../src/activities.ts";
import { buildUiState, type UiState } from "../src/ui/state.ts";
import { UI_HEIGHT, UI_WIDTH, escapeXml, renderPanelSvg } from "../src/ui/template.ts";

/**
 * The panel is the only thing a viewer reads, so the SVG is pinned: the canvas the encoder crops
 * for, the numbers the game published, and the guarantee that a nickname cannot inject markup. The
 * raster is made in the capture container (rsvg-convert), so nothing here needs a renderer.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));

function state(overrides: Partial<UiState> = {}): UiState {
  const base = buildUiState({
    score: { t: 12, ct: 9, topT: "Smith 7", topCt: "Neo 5" },
    target: { name: "Smith", hp: 87, armor: 42 },
    recent: [],
    catalog,
  });
  return { ...base, ...overrides };
}

test("the panel keeps the canvas the encoder crops for", () => {
  const svg = renderPanelSvg(state());
  assert.match(svg, new RegExp(`width="${UI_WIDTH}" height="${UI_HEIGHT}"`));
  assert.match(svg, /viewBox="0 0 720 1280"/);
  // Transparent background: every unpainted pixel has to keep the game visible.
  assert.doesNotMatch(svg, /<rect[^>]*width="720" height="1280"[^>]*fill="#/);
});

test("the score, both tops and the bot on camera reach the picture", () => {
  const svg = renderPanelSvg(state());
  assert.match(svg, />12</);
  assert.match(svg, />9</);
  assert.match(svg, />TOP Smith 7</);
  assert.match(svg, />TOP Neo 5</);
  assert.match(svg, /Smith {2}87 HP {2}42 AR/);
});

test("a missing score says so instead of drawing zeros", () => {
  const svg = renderPanelSvg(state({ score: null, target: null }));
  assert.match(svg, /WAITING FOR THE GAME/);
  assert.doesNotMatch(svg, />0</);
});

test("the theme picks the accent colour, a stale panel is dimmed", () => {
  assert.match(renderPanelSvg(state({ theme: "chaos" })), /#b06cff/);
  assert.match(renderPanelSvg(state({ theme: "fight" })), /#ff5a5a/);
  assert.match(renderPanelSvg(state({ stale: true })), /<g opacity="0.5">/);
});

test("nicknames are escaped: a viewer cannot break the SVG", () => {
  const svg = renderPanelSvg(state({ target: { name: '<b>&"x"\'</b>', hp: 1, armor: 0 } }));
  assert.doesNotMatch(svg, /<b>/);
  assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;&apos;&lt;\/b&gt;/);
  assert.equal(escapeXml("a<b"), "a&lt;b");
});

test("the panel pulls nothing from outside: no images, no remote fonts", () => {
  const svg = renderPanelSvg(state());
  // rsvg-convert runs without a network in the capture container, and a remote href would fail there.
  assert.doesNotMatch(svg, /<image|href=|url\(http/u);
  assert.match(svg, /font-family="DejaVu Sans"/);
});

test("the writer and the encoder agree on the file names", () => {
  const loop = readFileSync(new URL("../src/ui/loop.ts", import.meta.url), "utf8");
  const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");

  assert.match(loop, /export const UI_SVG = "ui\.svg"/);
  assert.match(entrypoint, /STREAM_UI_SVG:-\/overlay\/ui\/ui\.svg/, "the encoder reads another path");
  assert.match(entrypoint, /STREAM_UI_PNG:-\/overlay\/ui\/ui\.png/, "the encoder writes another path");
  // The rasteriser has to be in the image, or the panel silently never appears.
  const dockerfile = readFileSync(new URL("../infra/stream/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /librsvg2-bin/, "rsvg-convert is not installed in the capture image");
});
