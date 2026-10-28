/**
 * A local preview of the picture panel, without Docker and without a game server.
 *
 * `npm run ui-preview` prints a URL: the page shows the ten lines the control API writes for the
 * encoder, laid out with the same geometry `infra/stream/entrypoint.sh` uses. It is an
 * approximation - the real frame is composed by ffmpeg's drawtext from the same files and the same
 * numbers - but it is enough to tune the bar, the sizes and the wording without going live.
 */
import { createServer } from "node:http";
import { loadActivities } from "../src/activities.ts";
import type { StoredDonation } from "../src/db.ts";
import { PANEL_FILES, PANEL_LAYOUT, panelLayers } from "../src/ui/panel.ts";
import { buildUiState, type UiState } from "../src/ui/state.ts";

const port = Number(process.env["UI_PREVIEW_PORT"] ?? 4399);
const catalog = loadActivities("config/activities.json");

const demoDonation: StoredDonation = {
  id: 1,
  username: "Vasya",
  amount: 130,
  currency: "RUB",
  status: "applied",
  activityCode: process.env["UI_PREVIEW_ACTIVITY"] ?? "chaos_burst",
  receivedAt: new Date().toISOString(),
  source: "da",
};

function demoState(): UiState {
  const frags = Number(process.env["UI_PREVIEW_T"] ?? 37);
  return buildUiState({
    score: { t: frags, ct: 41, topT: "Mr Smith 12", topCt: "Neo 9" },
    target: { name: "Mr Smith", hp: 87, armor: 42 },
    recent: [demoDonation],
    catalog,
  });
}

/** Lays the ten files out the way drawtext does, so the sizes and the margins can be checked. */
function frame(state: UiState): string {
  const text = new Map(panelLayers(state).map((layer) => [layer.file, layer.text]));
  const at = (file: string): string => text.get(file) ?? "";
  const { barSize, scoreSize, topSize, targetSize, lastSize, menuSize, margin, top, bottom } =
    PANEL_LAYOUT;
  const row = (offset: number): number => top + offset;

  return `<div class="frame">
  <div class="line bar" style="top:${top}px">
    <span style="left:${margin}px;color:#dd3333;font-size:${barSize}px">${at(PANEL_FILES.barT)}</span>
    <span style="right:${margin}px;color:#3366dd;font-size:${barSize}px">${at(PANEL_FILES.barCt)}</span>
  </div>
  <div class="line score" style="top:${top + 14}px;font-size:${scoreSize}px">
    <span style="left:${margin + 12}px">${at(PANEL_FILES.scoreT)}</span>
    <span style="right:${margin + 12}px">${at(PANEL_FILES.scoreCt)}</span>
  </div>
  <div class="line" style="top:${row(72)}px;font-size:${topSize}px">
    <span style="left:${margin}px">${at(PANEL_FILES.topT)}</span>
    <span style="right:${margin}px">${at(PANEL_FILES.topCt)}</span>
  </div>
  <div class="line center" style="top:${row(124)}px;font-size:${targetSize}px">${at(PANEL_FILES.target)}</div>
  <div class="line center" style="top:${row(174)}px;font-size:${topSize}px">${at(PANEL_FILES.notice)}</div>
  <div class="line center" style="top:${1280 - bottom - 52}px;font-size:${lastSize}px">${at(PANEL_FILES.last)}</div>
  <div class="line center" style="top:${1280 - bottom}px;font-size:${menuSize}px">${at(PANEL_FILES.menu)}</div>
</div>`;
}

function page(state: UiState): string {
  const layers = panelLayers(state);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>panel preview</title>
<style>
  body { margin: 0; background: #1b1d22; color: #c9d1d9; font: 13px/1.5 system-ui, sans-serif; }
  main { display: flex; gap: 24px; padding: 16px; align-items: flex-start; }
  .frame { position: relative; width: 360px; height: 640px; background: #2b2f36; outline: 1px solid #3a4048;
           transform: scale(0.5); transform-origin: top left; }
  .wrap { width: 360px; height: 640px; overflow: hidden; outline: 1px solid #3a4048; }
  .line { position: absolute; width: 100%; font-family: "DejaVu Sans", sans-serif; font-weight: bold;
          color: #b9c2cf; white-space: pre; }
  .line span { position: absolute; }
  .line.center { text-align: center; }
  .bar span { color: inherit; }
  .score { color: #fff; text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000,
           -1px 1px 0 #000; }
  .note { max-width: 460px; }
  pre { max-width: 460px; overflow: auto; }
</style>
</head>
<body>
<main>
  <div class="wrap">${frame(state)}</div>
  <div class="note">
    <p>These are the ten files the control API writes; ffmpeg draws them with drawtext at
    720x1280. This page is an approximation of that frame, good enough to tune sizes and margins.</p>
    <p><code>UI_PREVIEW_ACTIVITY</code> picks the theme, <code>UI_PREVIEW_T</code> the terrorist
    frags (the bar moves with them).</p>
    <details><summary>files</summary><pre>${layers
      .map((layer) => `${layer.file}: ${JSON.stringify(layer.text)}`)
      .join("\n")}</pre></details>
    <details><summary>state</summary><pre>${JSON.stringify(state, null, 2)}</pre></details>
  </div>
</main>
</body>
</html>`;
}

createServer((_request, response) => {
  const state = demoState();
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(page(state));
}).listen(port, "127.0.0.1", () => {
  console.log(`panel preview: http://127.0.0.1:${port}`);
});

