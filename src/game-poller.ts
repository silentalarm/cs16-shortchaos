import type { UiScore, UiTarget } from "./ui/state.ts";

/**
 * What the panel needs from the game server, polled once a second.
 *
 * Two console commands, not six cvar reads: `plugins/team_war` already prints the race on one line
 * and `plugins/stream_cam` prints the bot on camera. Both are the same numbers the plugins publish
 * as cvars, so the panel and the game can never disagree.
 */
export const SCORE_COMMAND = "amx_team_war status";
export const TARGET_COMMAND = "amx_stcam status";

/** Matches `t=12 ct=9 top_t=Smith:7 top_ct=Neo:5` in any order, inside the surrounding sentence. */
const SCORE_FIELD = /(?:^|\s)(t|ct|top_t|top_ct)=(\S+)/gu;

function integer(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** `Smith:7` -> `Smith 7`; the plugin joins nicknames with underscores, chat has no spaces in a token. */
function top(value: string): string {
  const cut = value.lastIndexOf(":");
  const name = cut < 0 ? value : value.slice(0, cut);
  const frags = cut < 0 ? "" : value.slice(cut + 1);
  const printable = name.replace(/_/gu, " ").trim();
  return frags === "" ? printable : `${printable} ${frags}`;
}

/**
 * Parses the `team_war status:` line.
 *
 * Returns null when the reply carries no score at all: a server without the plugin, a typo in the
 * command or an RCON error page must leave the panel showing "no data" instead of `0 : 0`.
 */
export function parseScore(reply: string): UiScore | null {
  const found: Partial<Record<string, string>> = {};
  for (const match of reply.matchAll(SCORE_FIELD)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) found[key] = value;
  }

  const t = found["t"] === undefined ? null : integer(found["t"]);
  const ct = found["ct"] === undefined ? null : integer(found["ct"]);
  if (t === null || ct === null) return null;

  return {
    t,
    ct,
    topT: found["top_t"] === undefined ? "" : top(found["top_t"]),
    topCt: found["top_ct"] === undefined ? "" : top(found["top_ct"]),
  };
}

const TARGET_NAME = /(?:^|\s)target=(\S*)/u;
const TARGET_HP = /(?:^|\s)hp=(\d+)/u;
const TARGET_ARMOR = /(?:^|\s)ar=(\d+)/u;

/**
 * Parses the `stream_cam status:` line into the bot on camera.
 *
 * null when the camera has no target (`target=-`), which is what an empty spawn window looks like:
 * the panel then simply omits the line instead of printing "- 0 HP 0 AR".
 */
export function parseTarget(reply: string): UiTarget | null {
  const name = TARGET_NAME.exec(reply)?.[1] ?? "";
  if (name === "" || name === "-") return null;

  const hp = TARGET_HP.exec(reply)?.[1];
  const armor = TARGET_ARMOR.exec(reply)?.[1];

  return {
    name: name.replace(/_/gu, " ").trim(),
    hp: hp === undefined ? 0 : (integer(hp) ?? 0),
    armor: armor === undefined ? 0 : (integer(armor) ?? 0),
  };
}

export interface GamePollerOptions {
  /** Runs one RCON command; normally `RconClient.exec` of the shared client. */
  exec: (command: string) => Promise<string>;
  intervalMs?: number;
  /** Consecutive failed polls after which the data is reported as stale. */
  staleAfter?: number;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export interface GameSnapshot {
  score: UiScore | null;
  target: UiTarget | null;
  stale: boolean;
}

export const DEFAULT_POLL_MS = 1000;
export const DEFAULT_STALE_AFTER = 3;

/**
 * Polls the race and the camera target once a second.
 *
 * A chain of timeouts, not `setInterval`: an RCON call that hits its own timeout must not stack up
 * behind itself. Failures do not clear what we already know - the panel dims it instead, because a
 * blank scoreboard during a five second hiccup reads on stream as a broken overlay.
 */
export class GamePoller {
  readonly #exec: (command: string) => Promise<string>;
  readonly #intervalMs: number;
  readonly #staleAfter: number;
  readonly #log: (event: string, details?: Record<string, unknown>) => void;
  #score: UiScore | null = null;
  #target: UiTarget | null = null;
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;

  constructor(options: GamePollerOptions) {
    this.#exec = options.exec;
    this.#intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_POLL_MS);
    this.#staleAfter = Math.max(1, options.staleAfter ?? DEFAULT_STALE_AFTER);
    this.#log = options.log ?? (() => {});
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  snapshot(): GameSnapshot {
    return { score: this.#score, target: this.#target, stale: this.#failures >= this.#staleAfter };
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      const [scoreReply, targetReply] = await Promise.all([
        this.#exec(SCORE_COMMAND),
        this.#exec(TARGET_COMMAND),
      ]);

      const score = parseScore(scoreReply);
      if (score === null) {
        this.#fail();
      } else {
        this.#score = score;
        this.#target = parseTarget(targetReply);
        this.#recovered();
      }
    } catch (error) {
      this.#fail();
      // Once per streak, not once per second: a dead game server would otherwise fill the log.
      if (this.#failures === this.#staleAfter) {
        this.#log("game.unavailable", { error: (error as Error).message });
      }
    } finally {
      if (!this.#stopped) this.#timer = setTimeout(() => void this.#tick(), this.#intervalMs);
    }
  }

  #recovered(): void {
    if (this.#failures > 0) this.#log("game.recovered", { failures: this.#failures });
    this.#failures = 0;
  }

  #fail(): void {
    this.#failures += 1;
  }
}
