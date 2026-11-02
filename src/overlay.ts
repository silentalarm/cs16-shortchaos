import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivitiesConfig } from "./activities.ts";
import { formatCountdown, type NextAutoEvent } from "./auto-events.ts";
import type { StoredDonation } from "./db.ts";

/**
 * What the viewer reads under the picture.
 *
 * Three lines, fixed count: ffmpeg's drawtext re-reads the text file every frame (`reload=1`), and
 * a changing line count would make the block jump around. The text goes through a file instead of
 * inline filter arguments, which is also why nothing here has to be escaped for the filter graph —
 * except `%` and `\`, which drawtext expands even in file content and which therefore never reach it.
 *
 * The lines are: the invitation, the last donation (nickname and amount, nothing else - a long
 * message pushed the line off centre), and the countdown to the next free event.
 */
export const MAX_LINE_CHARS = 46;
export const HEADER = "DONATE IN CHAT -> CHANGE THE GAME";

export interface OverlayInput {
  recent: readonly StoredDonation[];
  catalog: ActivitiesConfig;
  /** The next free event (`auto-events.ts`); without it the last line lists the cheapest activities. */
  next?: NextAutoEvent | null;
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
 * `Vasya 50 RUB` - the nickname and the amount, nothing else.
 *
 * The viewer message and the `LAST:` label are gone on purpose: the line is centred under the
 * picture, and a ten character prefix plus a quoted message moved the one number the viewer looks
 * for. What the donation bought has its own place in the rotation line and in the log.
 */
function donationLine(row: StoredDonation, catalog: ActivitiesConfig): string {
  return clean(`${row.username} ${Math.round(row.amount)} ${catalog.currency}`, LAST_LINE_CHARS);
}

/**
 * `ДАЛЬШЕ 2:31 · HE PARTY` - the countdown to the next free event.
 *
 * Empty when the rotation is off; the caller then keeps the old "cheapest activities" line, so a
 * stream without `config/auto-events.json` still tells the viewer how to buy something.
 */
export function nextLine(next: NextAutoEvent | null | undefined): string {
  if (next === null || next === undefined) return "";
  return clean(`ДАЛЬШЕ ${formatCountdown(next.secondsLeft)} · ${next.title.toUpperCase()}`, MAX_LINE_CHARS);
}

export function buildOverlay(input: OverlayInput): Overlay {
  const { recent, catalog } = input;
  const now = input.now ?? Date.now();

  const last = recent.find((row) => row.status === "applied" || row.status === "queued");

  const lines: string[] = [HEADER];
  lines.push(last === undefined ? "NO DONATIONS YET - BE THE FIRST" : donationLine(last, catalog));

  // Two options, not three: the line has to stay inside MAX_LINE_CHARS to be readable at 720 px.
  const menu = cheapest(catalog, 2).join(" | ");
  lines.push(nextLine(input.next) || clean(`NEXT: ${menu}`, MAX_LINE_CHARS));

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
