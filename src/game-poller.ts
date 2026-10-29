import type { UiScore, UiTarget } from "./ui/state.ts";

/**
 * What the panel needs from the game server, polled once a second.
 *
 * One console command, not six cvar reads: `amx_full_status` (plugins/team_war) prints the race,
 * the bot on camera and the end-of-map duel in a single reply. It reads the cvars the plugins
 * publish, so the panel and the game can never disagree.
 *
 * Why one command and not three: RCON has no request id and `RconClient` serialises commands, so
 * three probes per tick cost three round-trips - and a paid activity waits behind every one.
 */
export const FULL_STATUS_COMMAND = "amx_full_status";
/** The pre-`amx_full_status` probes, kept as a fallback for a server still running an old build. */
export const SCORE_COMMAND = "amx_team_war status";
export const TARGET_COMMAND = "amx_stcam status";
/** The end-of-map duel (`plugins/map_duel`): who won it, printed for the few seconds before the map changes. */
export const DUEL_COMMAND = "amx_map_duel status";

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

const DUEL_STATE = /(?:^|\s)state=(\w+)/u;
const DUEL_WINNER = /(?:^|\s)winner=(\S*)/u;

/**
 * Parses the `map_duel status:` line into the winner's nickname; empty when there is none.
 *
 * The name is read only in `state=done`: the cvar keeps the last winner until the next map starts
 * its own count, and a stale name on a fresh map would credit somebody with a duel he did not fight.
 */
export function parseWinner(reply: string): string {
  const state = DUEL_STATE.exec(reply)?.[1] ?? "";
  if (state !== "done") return "";
  const winner = DUEL_WINNER.exec(reply)?.[1] ?? "-";
  const printable = winner.replace(/_/gu, " ").trim();
  return printable === "-" ? "" : printable;
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
  /** Winner of the end-of-map duel, empty until the duel of this map is decided. */
  winner: string;
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
  #winner = "";
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  /** Set once when `amx_full_status` is not on the server: the three probes are used from then on. */
  #legacy = false;

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
    return {
      score: this.#score,
      target: this.#target,
      winner: this.#winner,
      stale: this.#failures >= this.#staleAfter,
    };
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      const [scoreReply, targetReply, duelReply] = await this.#readResponses();

      const score = parseScore(scoreReply);
      if (score === null) {
        this.#fail();
      } else {
        this.#score = score;
        this.#target = parseTarget(targetReply);
        this.#winner = parseWinner(duelReply);
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

  /**
   * The three replies the tick parses: one RCON command when the server answers `amx_full_status`,
   * three otherwise.
   *
   * The fallback covers the window between a code deploy and an image rebuild - the panel would
   * otherwise sit on "no data" until somebody rebuilt the game server. It is decided once and never
   * retried: a server that dropped the command mid-stream is not coming back with it, and probing
   * it again every tick would cost the round-trip this path exists to save.
   */
  async #readResponses(): Promise<[string, string, string]> {
    if (!this.#legacy) {
      const reply = await this.#exec(FULL_STATUS_COMMAND);
      if (parseScore(reply) !== null) return [reply, reply, reply];
      this.#legacy = true;
      this.#log("game.legacy_status", { command: FULL_STATUS_COMMAND });
    }

    return Promise.all([this.#exec(SCORE_COMMAND), this.#exec(TARGET_COMMAND), this.#exec(DUEL_COMMAND)]);
  }

  #recovered(): void {
    if (this.#failures > 0) this.#log("game.recovered", { failures: this.#failures });
    this.#failures = 0;
  }

  #fail(): void {
    this.#failures += 1;
  }
}
