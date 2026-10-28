/**
 * A local preview of the picture panel, without Docker and without a game server.
 *
 * `npm run ui-preview` prints a URL: the page shows the exact SVG the control API writes for the
 * encoder, so the layout can be edited and reloaded in a browser while `src/ui/template.ts` is being
 * changed. The PNG is produced inside the capture container (`rsvg-convert`), which is where the
 * fonts live - this page only needs a browser to draw the same SVG.
 */
import { createServer } from "node:http";
import { loadActivities } from "../src/activities.ts";
import type { StoredDonation } from "../src/db.ts";
import { buildUiState, type UiState } from "../src/ui/state.ts";
import { renderPanelSvg } from "../src/ui/template.ts";

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
  return buildUiState({
    score: { t: 37, ct: 41, topT: "Mr Smith 12", topCt: "Neo 9" },
    target: { name: "Mr Smith", hp: 87, armor: 42 },
    recent: [demoDonation],
    catalog,
  });
}

function page(state: UiState, svg: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>panel preview</title>
<style>
  body { margin: 0; background: #1b1d22; color: #c9d1d9; font: 13px/1.5 system-ui, sans-serif; }
  main { display: flex; gap: 24px; padding: 16px; }
  .frame { background: #2b2f36; outline: 1px solid #3a4048; }
  .frame svg { display: block; width: 360px; height: 640px; }
  pre { max-width: 520px; overflow: auto; }
</style>
</head>
<body>
<main>
  <div class="frame">${svg}</div>
  <div>
    <p>The control API writes this SVG; the capture container rasterises it and the encoder overlays
    the PNG on the game frame.</p>
    <p>Set <code>UI_PREVIEW_ACTIVITY</code> to preview a theme: chaos_burst, bounty, bot_rain, bot_nick.</p>
    <details><summary>state</summary><pre>${JSON.stringify(state, null, 2)}</pre></details>
  </div>
</main>
</body>
</html>`;
}

createServer((_request, response) => {
  const state = demoState();
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(page(state, renderPanelSvg(state)));
}).listen(port, "127.0.0.1", () => {
  console.log(`panel preview: http://127.0.0.1:${port}`);
});
