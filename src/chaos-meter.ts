/**
 * The chaos meter: every donated rouble counts toward the next chaos burst.
 *
 * Why a meter and not a chaos ticket: a viewer who pays 50 RUB wants to see the effect of *their*
 * donation, but the stream also needs a reason for the crowd to keep giving after a small one. The
 * meter gives both - the event runs at once, and the money stays on a visible bar toward 1000 RUB,
 * where `chaos_core` fires a forced effect for everyone.
 *
 * The remainder carries over (`1050 -> chaos + 50`), because losing it would make the bar feel like a
 * slot machine that eats the overshoot.
 */
export const CHAOS_THRESHOLD = 1000;

export interface ChaosProgress {
  /** Money collected toward the next burst, always below the threshold. */
  total: number;
  /** How many bursts this amount paid for; 0 for the usual donation, more for a huge one. */
  bursts: number;
}

/** Rounds away float noise: money is in roubles, and `0.30000000000000004` on screen is a bug. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function addToChaos(total: number, amount: number, threshold = CHAOS_THRESHOLD): ChaosProgress {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const sum = safeTotal + safeAmount;
  if (!(threshold > 0)) return { total: money(sum), bursts: 0 };

  const bursts = Math.floor(sum / threshold);
  return { total: money(sum - bursts * threshold), bursts };
}

/**
 * How many of the `segments` blocks the meter has filled.
 *
 * Rounds down on purpose: a bar that shows one block for the first rouble reads as progress, a bar
 * that shows a full run one rouble before the burst reads as a lie.
 */
export function chaosFill(total: number, segments: number, threshold = CHAOS_THRESHOLD): number {
  if (!(threshold > 0) || segments <= 0) return 0;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const filled = Math.floor((safeTotal / threshold) * segments);
  return Math.min(segments, Math.max(0, filled));
}
