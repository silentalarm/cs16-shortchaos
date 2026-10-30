import type { UiState, UiScore } from "./state.ts";
import { CHAOS_THRESHOLD, chaosFill } from "../chaos-meter.ts";
import { clean } from "../overlay.ts";

/**
 * The panel as a set of plain text files, one per line drawn on screen.
 *
 * Why text files and not a rendered image: the encoder draws each line itself with `drawtext`,
 * which re-reads its file on every frame (`reload=1`) - the mechanism the donation line has always
 * used. A picture had to arrive as a second ffmpeg input, and both ways of feeding it froze: an
 * image file with `-loop 1` keeps the first decoded frame, and a FIFO of PNG frames showed the same
 * picture for minutes while the file on disk kept changing. A text file has neither problem.
 *
 * The cost is a smaller vocabulary: text, one colour per line, and rectangles. That is why the score
 * is a bar of block characters instead of numbers - `drawbox` cannot take its length from a file -
 * and why the two frag counts are their own small layers on top of the bar ends: a digit and a block
 * have different advances, so putting a number inside the bar file would shorten the run.
 */

/** One drawn line; `file` is the name inside the panel directory the encoder reads. */
export interface PanelLayer {
  file: string;
  text: string;
}

/**
 * The file names, shared with `infra/stream/entrypoint.sh`. A test pins both sides together: a
 * rename here and not there leaves a line that silently never appears.
 */
export const PANEL_FILES = {
  barT: "bar-t.txt",
  barCt: "bar-ct.txt",
  /** The frag counts drawn over the bar ends; separate files, see `countsFor()`. */
  scoreT: "score-t.txt",
  scoreCt: "score-ct.txt",
  topT: "top-t.txt",
  topCt: "top-ct.txt",
  target: "target.txt",
  notice: "notice.txt",
  last: "last.txt",
  /** What the last donation bought: every name of the batch on its own line. */
  won: "won.txt",
  menu: "menu.txt",
  /** The chaos meter: money collected toward the next forced effect. */
  chaos: "chaos.txt",
} as const;

/**
 * Geometry in pixels of the 720x1280 frame. The defaults are duplicated in the entrypoint as
 * `${STREAM_UI_*:-default}` (the encoder has to work without the control API), and a test compares
 * the two so the preview page cannot drift from the real frame.
 */
export const PANEL_LAYOUT = {
  barSize: 40,
  /** The frag counts over the blocks: smaller than the bar so they sit inside it. */
  scoreSize: 28,
  topSize: 30,
  targetSize: 36,
  lastSize: 26,
  menuSize: 24,
  /** The chaos meter: smaller than the score bar, it only ever fills. */
  chaosSize: 26,
  margin: 52,
  top: 36,
  bottom: 186,
} as const;

/**
 * U+2588 FULL BLOCK, and nothing else: measured in the capture image at fontsize 40, every block
 * character in DejaVu Sans Bold has the same 0.77 em advance, while U+2591 LIGHT SHADE was 5 px
 * narrower over twenty characters. Mixing them would move the bar, which is the flicker this design
 * exists to avoid.
 */
export const BAR_BLOCK = "\u2588";

/** Twenty blocks: at fontsize 40 the run is 614 px wide, which fits 720 px with 52 px margins. */
export const PANEL_DEFAULT_SEGMENTS = 20;

/**
 * How many of the `segments` belong to each side.
 *
 * The two runs always add up to `segments`, so the bar keeps its width and only the point where the
 * teams meet moves. Rounding goes to the terrorists; with no frags at all the bar is split evenly
 * instead of leaning to one side.
 */
export function barSplit(
  t: number,
  ct: number,
  segments = PANEL_DEFAULT_SEGMENTS,
): { t: number; ct: number } {
  const safeT = Number.isFinite(t) && t > 0 ? t : 0;
  const safeCt = Number.isFinite(ct) && ct > 0 ? ct : 0;
  const total = safeT + safeCt;
  if (total === 0) {
    const half = Math.round(segments / 2);
    return { t: half, ct: segments - half };
  }
  const tSegments = Math.round((safeT / total) * segments);
  return { t: tSegments, ct: segments - tSegments };
}

/**
 * A run of blocks, or a single space.
 *
 * Never an empty string: an empty text file makes `drawtext` draw nothing (verified, no error), but
 * a space keeps the file non-empty and the layer count stable, which is easier to reason about when
 * the bar is at one of its extremes.
 */
function blocks(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return n === 0 ? " " : BAR_BLOCK.repeat(n);
}

/**
 * `Mr Smith 7` -> `Mr Smith`: the frag counts are what the bar replaced, so the tops show names.
 * The poller appends the count to the nickname, not the other way round.
 */
export function topName(top: string): string {
  return top.replace(/\s+\d+$/u, "").trim();
}

/** How many characters each line can hold at its font size before it runs past the frame. */
export const PANEL_LIMITS = {
  top: 20,
  target: 30,
  notice: 24,
  last: 41,
  won: 41,
  menu: 44,
  chaos: 30,
} as const;

/** Ten blocks: the chaos bar is half the score bar's width and has no counts on its ends. */
export const CHAOS_SEGMENTS = 10;

/**
 * `ХАОС ██████░░░░ 600/1000 RUB`.
 *
 * Its own line, not a third run on the score bar: that bar is a fight for the middle, this one only
 * ever fills, and one row made both read as a score. The empty half is U+2591 LIGHT SHADE - it is a
 * few pixels narrower than a full block, so the line shifts by ~2 px across the whole meter, which is
 * invisible at 26 px and much cheaper than a second drawbox.
 */
function chaosFor(state: UiState): string {
  const threshold = state.chaos.threshold > 0 ? state.chaos.threshold : CHAOS_THRESHOLD;
  const total = state.chaos.total > 0 ? state.chaos.total : 0;
  const filled = chaosFill(total, CHAOS_SEGMENTS, threshold);
  const bar = BAR_BLOCK.repeat(filled) + "\u2591".repeat(CHAOS_SEGMENTS - filled);
  return clean(`ХАОС ${bar} ${Math.round(total)}/${Math.round(threshold)} RUB`, PANEL_LIMITS.chaos);
}

/**
 * The line that says what the map is doing; empty when everything is fine.
 *
 * The duel winner comes first: it is on screen for five seconds before the map changes, and a stale
 * poll during those seconds would hide the only thing the viewer is waiting for.
 */
function noticeFor(state: UiState): string {
  if (state.winner !== "") return clean(`WINNER: ${state.winner}`, PANEL_LIMITS.notice);
  if (state.stale) return clean("NO SIGNAL FROM THE GAME", PANEL_LIMITS.notice);
  if (state.score === null) return clean("WAITING FOR THE GAME", PANEL_LIMITS.notice);
  return "";
}

function barsFor(score: UiScore | null, segments: number): { t: string; ct: string } {
  if (score === null) return { t: " ", ct: " " };
  const split = barSplit(score.t, score.ct, segments);
  return { t: blocks(split.t), ct: blocks(split.ct) };
}

/**
 * The frag counts as text, drawn over the outer ends of the bar.
 *
 * Their own layers on purpose: a digit advances 0.64 em against a block's 0.77 em, so a number
 * written into `bar-t.txt` would shorten the red run and move the meeting point - the crawl the bar
 * exists to avoid. Empty when there is no score, so the encoder draws nothing instead of `0`.
 */
function countsFor(score: UiScore | null): { t: string; ct: string } {
  if (score === null) return { t: "", ct: "" };
  return { t: String(score.t), ct: String(score.ct) };
}

/**
 * Everything the frame shows, as files. Pure: the same state produces the same bytes, which is what
 * lets the loop skip writing when nothing changed.
 *
 * Every value goes through `clean()` from overlay.ts: it drops control characters and the two
 * characters drawtext expands even in file content (`%` and `\`), so a nickname cannot damage the
 * line it is printed on.
 */
export function panelLayers(state: UiState, segments = PANEL_DEFAULT_SEGMENTS): PanelLayer[] {
  const bars = barsFor(state.score, segments);
  const counts = countsFor(state.score);
  const score = state.score;

  return [
    { file: PANEL_FILES.barT, text: bars.t },
    { file: PANEL_FILES.barCt, text: bars.ct },
    { file: PANEL_FILES.scoreT, text: counts.t },
    { file: PANEL_FILES.scoreCt, text: counts.ct },
    {
      file: PANEL_FILES.topT,
      text: score === null ? "" : clean(`TOP ${topName(score.topT)}`.trim(), PANEL_LIMITS.top + 4),
    },
    {
      file: PANEL_FILES.topCt,
      text: score === null ? "" : clean(`TOP ${topName(score.topCt)}`.trim(), PANEL_LIMITS.top + 4),
    },
    {
      file: PANEL_FILES.target,
      text: state.target === null
        ? ""
        : clean(
            `${state.target.name} ${state.target.hp} HP ${state.target.armor} AR`,
            PANEL_LIMITS.target,
          ),
    },
    { file: PANEL_FILES.notice, text: noticeFor(state) },
    { file: PANEL_FILES.last, text: clean(state.donation, PANEL_LIMITS.last) },
    { file: PANEL_FILES.won, text: clean(state.won, PANEL_LIMITS.won) },
    { file: PANEL_FILES.menu, text: clean(state.menu, PANEL_LIMITS.menu) },
    { file: PANEL_FILES.chaos, text: chaosFor(state) },
  ];
}
