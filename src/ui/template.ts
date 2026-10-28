import type { UiState, UiTheme } from "./state.ts";

/**
 * The panel drawn over the game frame.
 *
 * 720x1280 with a transparent background: the encoder overlays this PNG on top of the captured
 * game, so every pixel that is not painted keeps the game visible. The layout is deliberately
 * restricted to the top third (score, both team tops, the bot on camera) and the strip above the
 * bottom edge (the last donation and how to buy the next one), because the Shorts UI owns the right
 * edge and the bottom ~150 px.
 *
 * Everything here is a pure function of the state: same state, same bytes. That is what lets the
 * loop skip re-rendering unchanged frames.
 */
export const UI_WIDTH = 720;
export const UI_HEIGHT = 1280;

/** Accent colour per theme; the rest of the panel is neutral, so a new theme is three numbers. */
const ACCENTS: Record<UiTheme, string> = {
  default: "#4ea1ff",
  chaos: "#b06cff",
  fight: "#ff5a5a",
  event: "#4ade80",
};

const TEAM_T = "#f0a03c";
const TEAM_CT = "#5aa9e6";
const WHITE = "#ffffff";
const MUTED = "#b9c2cf";

/** Escapes the five characters XML needs; a nickname is user input and must never break the SVG. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

interface TextOptions {
  x: number;
  y: number;
  size: number;
  fill: string;
  anchor?: "start" | "middle" | "end";
  bold?: boolean;
  opacity?: number;
}

function text(value: string, options: TextOptions): string {
  if (value === "") return "";
  const anchor = options.anchor ?? "start";
  const weight = options.bold === true ? ' font-weight="bold"' : "";
  const opacity = options.opacity === undefined ? "" : ` opacity="${options.opacity}"`;
  return (
    `<text x="${options.x}" y="${options.y}" font-family="DejaVu Sans" font-size="${options.size}"` +
    ` fill="${options.fill}"${weight}${opacity} text-anchor="${anchor}">${escapeXml(value)}</text>`
  );
}

/** Draws the score, or the reason there is none, so the panel never shows a fake 0 : 0. */
function scoreBlock(state: UiState, accent: string): string {
  if (state.score === null) {
    return text("WAITING FOR THE GAME", { x: UI_WIDTH / 2, y: 120, size: 30, fill: MUTED, anchor: "middle", bold: true });
  }

  const { t, ct, topT, topCt } = state.score;
  return [
    text("T", { x: 48, y: 64, size: 20, fill: TEAM_T, bold: true }),
    text(String(t), { x: 48, y: 132, size: 76, fill: TEAM_T, bold: true }),
    text(":", { x: UI_WIDTH / 2, y: 126, size: 64, fill: WHITE, anchor: "middle", bold: true, opacity: 0.85 }),
    text("CT", { x: UI_WIDTH - 48, y: 64, size: 20, fill: TEAM_CT, anchor: "end", bold: true }),
    text(String(ct), { x: UI_WIDTH - 48, y: 132, size: 76, fill: TEAM_CT, anchor: "end", bold: true }),
    text(topT === "" ? "" : `TOP ${topT}`, { x: 48, y: 176, size: 22, fill: MUTED, bold: true }),
    text(topCt === "" ? "" : `TOP ${topCt}`, { x: UI_WIDTH - 48, y: 176, size: 22, fill: MUTED, anchor: "end", bold: true }),
    text(state.activityCode === null ? "" : accentMarker(state), {
      x: UI_WIDTH / 2,
      y: 214,
      size: 20,
      fill: accent,
      anchor: "middle",
      bold: true,
    }),
  ].join("");
}

/** The paid activity currently in force, if any; the theme already colours the accent bar. */
function accentMarker(state: UiState): string {
  return state.activityCode === null ? "" : state.activityCode.replace(/_/gu, " ").toUpperCase();
}

export function renderPanelSvg(state: UiState): string {
  const accent = ACCENTS[state.theme];
  const dim = state.stale ? 0.5 : 1;

  const target = state.target === null
    ? ""
    : text(`${state.target.name}  ${state.target.hp} HP  ${state.target.armor} AR`, {
        x: UI_WIDTH / 2,
        y: 250,
        size: 24,
        fill: WHITE,
        anchor: "middle",
        bold: true,
      });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${UI_WIDTH}" height="${UI_HEIGHT}" viewBox="0 0 ${UI_WIDTH} ${UI_HEIGHT}">`,
    "<defs>",
    '<linearGradient id="top" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#080a0e" stop-opacity="0.88"/>',
    '<stop offset="1" stop-color="#080a0e" stop-opacity="0.0"/>',
    "</linearGradient>",
    '<linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#080a0e" stop-opacity="0.0"/>',
    '<stop offset="1" stop-color="#080a0e" stop-opacity="0.88"/>',
    "</linearGradient>",
    "</defs>",
    `<g opacity="${dim}">`,
    `<rect x="0" y="0" width="${UI_WIDTH}" height="270" fill="url(#top)"/>`,
    `<rect x="0" y="268" width="${UI_WIDTH}" height="4" fill="${accent}" opacity="0.9"/>`,
    scoreBlock(state, accent),
    target,
    `<rect x="0" y="1008" width="${UI_WIDTH}" height="150" fill="url(#bottom)"/>`,
    text(state.donation, { x: UI_WIDTH / 2, y: 1084, size: 26, fill: WHITE, anchor: "middle", bold: true }),
    text(state.menu, { x: UI_WIDTH / 2, y: 1124, size: 20, fill: MUTED, anchor: "middle" }),
    "</g>",
    "</svg>",
  ].join("");
}
