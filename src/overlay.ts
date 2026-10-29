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

export function buildOverlay(input: OverlayInput): Overlay {
  const { recent, catalog } = input;
  const pending = input.pending ?? [];
  const now = input.now ?? Date.now();

  const last = recent.find((row) => row.status === "applied" || row.status === "queued");

  const lines: string[] = [HEADER];

  if (last === undefined) {
    lines.push("NO DONATIONS YET - BE THE FIRST");
  } else {
    // A row may list several codes ("he_party+bounty") when one donation bought more than one
    // effect; the banner names the first one, which is the one the viewer saw first.
    const code = typeof last.activityCode === "string" ? last.activityCode.split("+")[0] ?? null : null;
    const activity = catalog.activities.find((item) => item.code === code);
    const what = activity === undefined ? "QUEUED" : activity.title.toUpperCase();
    const state = last.status === "queued" ? "WAITING " : "";
    lines.push(clean(`LAST: ${state}${last.username} ${Math.round(last.amount)} ${catalog.currency} - ${what}`));
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
