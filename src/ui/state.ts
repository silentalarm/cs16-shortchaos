import type { ActivitiesConfig } from "../activities.ts";
import type { StoredDonation } from "../db.ts";
import { buildOverlay } from "../overlay.ts";
import type { PendingActivity } from "../queue.ts";

/**
 * Everything the picture shows, in one plain object.
 *
 * Why a model instead of text: the panel is written as separate drawtext lines (`ui/panel.ts`), and a
 * builder must not care where the numbers came from - the game publishes the team race as cvars, the
 * control API knows the donations and the queue. Keeping the shape flat also means a line can be
 * added (or a second variant added per activity) without touching the poller or the encoder.
 */
export interface UiScore {
  /** Frags of the terrorist side, as the server counts them (team kills included). */
  t: number;
  ct: number;
  /** "name frags" for the best player of each side, already unescaped for display. */
  topT: string;
  topCt: string;
}

/** The bot the spectator camera is locked on; `name` is printable, hp/armor 0..255. */
export interface UiTarget {
  name: string;
  hp: number;
  armor: number;
}

/**
 * One activity theme per template. The catalogue keeps growing, so the mapping lives here and not in
 * the template: adding a code to THEMES is the whole change a new visual variant needs.
 */
export type UiTheme = "default" | "chaos" | "fight" | "event";

export interface UiState {
  /** null until the first successful RCON answer; the template says "no data" instead of lying. */
  score: UiScore | null;
  target: UiTarget | null;
  /** Last donation line, already cleaned for display. */
  donation: string;
  /** What the next cheapest activities cost, or how many are waiting. */
  menu: string;
  /** Winner of the end-of-map duel; empty except for the seconds between the duel and the map change. */
  winner: string;
  queueSize: number;
  theme: UiTheme;
  activityCode: string | null;
  /** true when the score is older than a few polls: the panel dims instead of showing stale numbers as fresh. */
  stale: boolean;
  updatedAt: string;
}

export interface UiStateInput {
  score: UiScore | null;
  target?: UiTarget | null;
  winner?: string;
  recent: readonly StoredDonation[];
  catalog: ActivitiesConfig;
  pending?: readonly PendingActivity[];
  now?: number;
  stale?: boolean;
}

const THEMES: Record<UiTheme, readonly string[]> = {
  chaos: ["chaos_burst", "curse_leader", "moon_gravity"],
  fight: ["bounty", "hot_potato", "boss_raid"],
  event: ["bot_rain", "terminators", "terminator_one", "zombie_round", "map_change"],
  default: [],
};

/** The theme of a paid activity; unknown codes (an override file) fall back to `default`. */
export function themeFor(code: string | null): UiTheme {
  if (code === null) return "default";
  for (const [theme, codes] of Object.entries(THEMES)) {
    if (codes.includes(code)) return theme as UiTheme;
  }
  return "default";
}

/**
 * Builds the state from what the processes around it already know.
 *
 * The donation and menu lines come from `buildOverlay()` on purpose: that function owns the length
 * and character rules a 720 px frame can survive, and the panel must not grow a second opinion
 * about them.
 */
export function buildUiState(input: UiStateInput): UiState {
  const now = input.now ?? Date.now();
  const pending = input.pending ?? [];
  const overlay = buildOverlay({
    recent: input.recent,
    catalog: input.catalog,
    pending,
    now,
  });

  const recent = input.recent.find((row) => row.status === "applied" || row.status === "queued");
  const activityCode = recent?.activityCode ?? null;

  return {
    score: input.score,
    target: input.target ?? null,
    winner: input.winner ?? "",
    donation: overlay.lines[1] ?? "",
    menu: overlay.lines[2] ?? "",
    queueSize: pending.length,
    theme: themeFor(activityCode),
    activityCode,
    stale: input.stale ?? false,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * A string that changes exactly when the picture would change.
 *
 * The loop renders on every tick only when this differs: at 5 fps a re-render per tick would spend
 * CPU on bytes identical to the previous frame (`updatedAt` is deliberately not part of it).
 */
export function uiSignature(state: UiState): string {
  return JSON.stringify({
    score: state.score,
    target: state.target,
    winner: state.winner,
    donation: state.donation,
    menu: state.menu,
    queueSize: state.queueSize,
    theme: state.theme,
    stale: state.stale,
  });
}
