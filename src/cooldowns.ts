import type { Activity } from "./activities.ts";

/**
 * Cooldowns are evaluated against facts already stored in SQLite (last applied donation),
 * not against an in-memory timer, so a restart of the control API cannot be used to
 * bypass them.
 */
export type CooldownReason = "donor_cooldown" | "activity_cooldown";

export type CooldownVerdict =
  | { allowed: true }
  | { allowed: false; reason: CooldownReason; retryAfterSec: number };

export interface CooldownInput {
  activity: Pick<Activity, "code" | "cooldownSec" | "globalCooldownSec">;
  /** Current time, milliseconds. */
  now: number;
  /** Timestamp of the last applied activity for this donor, milliseconds. */
  lastAppliedByDonor: number | null;
  /** Timestamp of the last applied run of this activity, milliseconds. */
  lastAppliedByActivity: number | null;
}

/** Parses a SQLite ISO timestamp into milliseconds, null stays null. */
export function msFromIso(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function remainingSec(last: number | null, now: number, windowSec: number): number {
  if (last === null || windowSec <= 0) return 0;
  const elapsedSec = Math.max(0, (now - last) / 1000);
  if (elapsedSec >= windowSec) return 0;
  return Math.ceil(windowSec - elapsedSec);
}

export function checkCooldown(input: CooldownInput): CooldownVerdict {
  const donorRemaining = remainingSec(input.lastAppliedByDonor, input.now, input.activity.cooldownSec);
  if (donorRemaining > 0) {
    return { allowed: false, reason: "donor_cooldown", retryAfterSec: donorRemaining };
  }

  const activityRemaining = remainingSec(input.lastAppliedByActivity, input.now, input.activity.globalCooldownSec);
  if (activityRemaining > 0) {
    return { allowed: false, reason: "activity_cooldown", retryAfterSec: activityRemaining };
  }

  return { allowed: true };
}
