import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivitiesConfig } from "./activities.ts";
import type { StoredDonation } from "./db.ts";
import type { PendingActivity } from "./queue.ts";

/**
 * What the viewer reads under the picture.
 *
 * Three lines, fixed count: ffmpeg's drawtext re-reads the text file every frame (`reload=1`), and
 * a changing line count would make the block jump around. The text goes through a file instead of
 * inline filter arguments, which is also why nothing here has to be escaped for the filter graph —
 * except `%` and `\`, which drawtext expands even in file content and which therefore never reach it.
 */
export const MAX_LINE_CHARS = 46;
export const HEADER = "DONATE IN CHAT -> CHANGE THE GAME";

export interface OverlayInput {
  recent: readonly StoredDonation[];
  catalog: ActivitiesConfig;
  pending?: readonly PendingActivity[];
  now?: number;
}

export interface Overlay {
  lines: string[];
  /** Exactly what ffmpeg reads: the lines joined with newlines. */
  text: string;
  updatedAt: string;
}

/** Collapses whitespace, drops control characters and defuses drawtext expansion. */
export function clean(value: string, limit = MAX_LINE_CHARS): string {
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\%]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function cheapest(catalog: ActivitiesConfig, count: number): string[] {
  return catalog.activities
    .filter((activity) => activity.enabled)
    .sort((left, right) => left.price - right.price || left.code.localeCompare(right.code))
    .slice(0, count)
    .map((activity) => `${activity.price} ${activity.title.toUpperCase()}`);
}

/**
 * The donation line is drawn at fontsize 26 in a 720 px frame: 41 characters is the measured fit, and
 * the same number is the panel's `PANEL_LIMITS.last`, so neither side has to cut what the other wrote.
 */
export const LAST_LINE_CHARS = 41;

/**
 * `LAST: Vasya 50 RUB`, with the viewer's message when it fits.
 *
 * The event name moved to its own line (`wonLine`): a big donation buys several effects, and a single
 * strip had room for exactly one of them, so the rest of what the money bought was simply cut off.
 */
function donationLine(row: StoredDonation, catalog: ActivitiesConfig): string {
  const state = row.status === "queued" ? "WAITING " : "";
  const head = `LAST: ${state}${row.username} ${Math.round(row.amount)} ${catalog.currency}`;
  const message = typeof row.message === "string" ? clean(row.message, LAST_LINE_CHARS).trim() : "";

  if (message !== "") {
    const withMessage = `${head}: "${message}"`;
    if (withMessage.length <= LAST_LINE_CHARS) return clean(withMessage, LAST_LINE_CHARS);
  }
  return clean(head, LAST_LINE_CHARS);
}

/**
 * `ВЫПАЛО: ДУЭЛЬ, ПУШКА, ОДНА ПУЛЯ` - every effect the donation bought, in the order they started.
 *
 * Its own line so a batch of five keeps all five names; when even that is too long the tail is cut
 * with an ellipsis instead of silently dropping whole events.
 */
export function wonLine(row: StoredDonation | undefined, catalog: ActivitiesConfig): string {
  if (row === undefined) return "";
  const codes = typeof row.activityCode === "string" && row.activityCode !== "" ? row.activityCode.split("+") : [];
  const names = codes.map((code) => {
    const activity = catalog.activities.find((item) => item.code === code);
    if (activity === undefined) return "QUEUED";
    // `params.short` is the label that fits five names on one row ("ПУШКА", "МЕТЕОР"); the spoken line
    // and the catalogue stay in full.
    const short = activity.params["short"];
    if (typeof short === "string" && short.trim() !== "") return short.trim();
    const spoken = activity.params["say"];
    return typeof spoken === "string" && spoken.trim() !== "" ? spoken.trim() : activity.title.toUpperCase();
  });
  if (names.length === 0) return "";

  const labelled = `ВЫПАЛО: ${names.join(", ")}`;
  if (labelled.length <= LAST_LINE_CHARS) return clean(labelled, LAST_LINE_CHARS);

  // The bare list under "LAST: ..." still reads as "what that donation bought", and it is what makes a
  // batch of five fit: the prefix costs eight characters, a whole event name costs ten.
  const bare = names.join(", ");
  return bare.length <= LAST_LINE_CHARS ? clean(bare, LAST_LINE_CHARS) : clean(labelled, LAST_LINE_CHARS);
}

export function buildOverlay(input: OverlayInput): Overlay {
  const { recent, catalog } = input;
  const pending = input.pending ?? [];
  const now = input.now ?? Date.now();

  const last = recent.find((row) => row.status === "applied" || row.status === "queued");

  const lines: string[] = [HEADER];

  if (last === undefined) {
    lines.push("NO DONATIONS YET - BE THE FIRST");
    lines.push("");
  } else {
    lines.push(donationLine(last, catalog));
    lines.push(wonLine(last, catalog));
  }

  // Two options, not three: the line has to stay inside MAX_LINE_CHARS to be readable at 720 px.
  const menu = cheapest(catalog, 2).join(" | ");
  lines.push(clean(pending.length > 0 ? `QUEUE: ${pending.length} | ${menu}` : `NEXT: ${menu}`));

  return { lines, text: lines.join("\n"), updatedAt: new Date(now).toISOString() };
}

/**
 * Writes `overlay.txt` (for ffmpeg) and `overlay.json` (for the panel and for debugging).
 * Both go through a temporary file and a rename: the encoder reads the text file every frame, and
 * a half-written line would show up on the stream.
 */
export function writeOverlay(dir: string, overlay: Overlay): void {
  mkdirSync(dir, { recursive: true });

  const textPath = join(dir, "overlay.txt");
  const temporary = `${textPath}.tmp`;
  writeFileSync(temporary, `${overlay.text}\n`, "utf8");
  renameSync(temporary, textPath);

  const jsonPath = join(dir, "overlay.json");
  const jsonTemporary = `${jsonPath}.tmp`;
  writeFileSync(jsonTemporary, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
  renameSync(jsonTemporary, jsonPath);
}
