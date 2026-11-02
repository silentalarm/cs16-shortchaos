import type { ActivitiesConfig } from "../activities.ts";
import type { NextAutoEvent } from "../auto-events.ts";
import { CHAOS_THRESHOLD } from "../chaos-meter.ts";
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

/**
 * The chaos meter, as the panel draws it: money collected toward the next forced effect.
 * `threshold` travels with the value so the bar and the trigger always agree on what "full" means.
 */
export interface UiChaos {
  total: number;
  threshold: number;
}

export interface UiState {
  /** null until the first successful RCON answer; the template says "no data" instead of lying. */
  score: UiScore | null;
  target: UiTarget | null;
  /** Last donation line: the nickname and the amount, nothing else. */
  donation: string;
  /** Countdown to the next free event (`ДАЛЬШЕ 2:31 · HE PARTY`), or the cheapest activities when the rotation is off. */
  next: string;
  /** Winner of the end-of-map duel; empty except for the seconds between the duel and the map change. */
  winner: string;
  /** Paid activities waiting for their cooldown; shown in the state dump and in the admin page. */
  queueSize: number;
  theme: UiTheme;
  activityCode: string | null;
  /** Donations collected toward the next chaos burst (`CHAOS_THRESHOLD` roubles). */
  chaos: UiChaos;
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
  /** The next free event from `auto-events.ts`; absent when the rotation is off. */
  next?: NextAutoEvent | null;
  chaos?: UiChaos;
  now?: number;
  stale?: boolean;
}

/**
 * The codes a theme owns. Only real catalogue codes belong here: the chaos list is the one a chaos
 * burst may fire (`config/auto-events.json`), so the picture and the meter agree on what chaos is.
 */
const THEMES: Record<UiTheme, readonly string[]> = {
  chaos: ["he_party", "meteor_shower", "jumpers", "bazooka_drop", "one_bullet", "chaos_plague"],
  fight: [
    "nemesis",
    "survivor",
    "juggernaut",
    "sniper",
    "outbreak",
    "raptors",
    "brutes",
    "regenerators",
    "glass_cannon",
    "lightsaber_duel",
  ],
  event: ["runners", "red_light", "fire_grenades", "freeze_nades", "airstrike", "weapon_rain", "guntrain"],
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
 * The donation and rotation lines come from `buildOverlay()` on purpose: that function owns the length
 * and character rules a 720 px frame can survive, and the panel must not grow a second opinion about
 * them.
 */
export function buildUiState(input: UiStateInput): UiState {
  const now = input.now ?? Date.now();
  const pending = input.pending ?? [];
  const next = input.next ?? null;
  const overlay = buildOverlay({
    recent: input.recent,
    catalog: input.catalog,
    next,
    now,
  });

  const recent = input.recent.find((row) => row.status === "applied" || row.status === "queued");
  const activityCode = recent?.activityCode ?? null;

  return {
    score: input.score,
    target: input.target ?? null,
    winner: input.winner ?? "",
    donation: overlay.lines[1] ?? "",
    next: overlay.lines[2] ?? "",
    queueSize: pending.length,
    theme: themeFor(activityCode),
    activityCode,
    chaos: input.chaos ?? { total: 0, threshold: CHAOS_THRESHOLD },
    stale: input.stale ?? false,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * A string that changes exactly when the picture would change.
 *
 * The loop renders on every tick only when this differs: at 5 fps a re-render per tick would spend
 * CPU on bytes identical to the previous frame (`updatedAt` is deliberately not part of it). The
 * countdown *is* part of it - the rotation line ticks down once a second.
 */
export function uiSignature(state: UiState): string {
  return JSON.stringify({
    score: state.score,
    target: state.target,
    winner: state.winner,
    donation: state.donation,
    next: state.next,
    queueSize: state.queueSize,
    theme: state.theme,
    chaos: state.chaos,
    stale: state.stale,
  });
}
