import type { ActivitiesConfig } from "./activities.ts";
import { buildActivityCommand } from "./command.ts";
import { checkCooldown, msFromIso } from "./cooldowns.ts";
import type { DonationRow, DonationSource, DonationStatus, Store } from "./db.ts";
import { resolveDonation } from "./mapping.ts";

/**
 * One polling pass: fetch, dedup, map to an activity, respect cooldowns, apply through RCON,
 * persist the verdict. Every donation ends up in the database with a status, so a rejected
 * donation can be explained later instead of vanishing.
 */
export interface PollDeps extends DonationDeps {
  /** Returns donations; the poller itself ignores ids <= cursor. */
  fetchDonations: (cursor: number) => Promise<DonationRow[]>;
}

/** Everything processing one donation needs. The admin panel uses this without a poll source. */
export interface DonationDeps {
  store: Store;
  catalog: ActivitiesConfig;
  /** Sends the command to the game server (RCON or a dry run logger). */
  apply: (command: string) => Promise<string>;
  now?: () => number;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export interface PollSummary {
  seen: number;
  applied: number;
  rejected: number;
  cooled: number;
  failed: number;
  duplicates: number;
}

export interface ProcessOptions {
  /** Real donations advance the cursor; a simulation must not, or it would skip live donations. */
  advanceCursor?: boolean;
  /** Debug only: skip cooldowns, still record the row so the verdict stays visible in history. */
  bypassCooldown?: boolean;
  source?: DonationSource;
}

/** What one donation turned into, returned to the admin panel so a test run is explainable. */
export interface ProcessOutcome {
  status: DonationStatus | "duplicate";
  activityCode: string | null;
  reason: string | null;
  command: string | null;
  reply: string | null;
}

/**
 * The whole pipeline for a single donation: dedup, amount mapping, cooldown, RCON, history.
 * Extracted from the poll loop so the admin panel can inject a fake donation and exercise
 * exactly the same code instead of a parallel "debug" path that could drift.
 */
export async function processDonation(
  deps: DonationDeps,
  donation: DonationRow,
  options: ProcessOptions = {},
): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const advanceCursor = options.advanceCursor ?? true;
  const source = options.source ?? "da";
  const timestamp = now();
  const receivedAt = new Date(timestamp).toISOString();

  if (deps.store.has(donation.id)) {
    if (advanceCursor) deps.store.setLastSeenId(donation.id);
    return { status: "duplicate", activityCode: null, reason: null, command: null, reply: null };
  }

  const resolution = resolveDonation({ amount: donation.amount, currency: donation.currency }, deps.catalog);
  if (resolution.kind === "reject") {
    deps.store.record({ ...donation, status: "rejected", activityCode: null, reason: resolution.reason, receivedAt, source });
    if (advanceCursor) deps.store.setLastSeenId(donation.id);
    log("donation.rejected", { id: donation.id, amount: donation.amount, reason: resolution.reason, source });
    return { status: "rejected", activityCode: null, reason: resolution.reason, command: null, reply: null };
  }

  const activity = resolution.activity;
  if (!options.bypassCooldown) {
    const verdict = checkCooldown({
      activity,
      now: timestamp,
      lastAppliedByDonor: msFromIso(deps.store.lastAppliedByDonor(donation.username)),
      lastAppliedByActivity: msFromIso(deps.store.lastAppliedByActivity(activity.code)),
    });

    if (!verdict.allowed) {
      const reason = `${verdict.reason}:${verdict.retryAfterSec}s`;
      deps.store.record({ ...donation, status: "cooldown", activityCode: activity.code, reason, receivedAt, source });
      if (advanceCursor) deps.store.setLastSeenId(donation.id);
      log("donation.cooldown", { id: donation.id, activity: activity.code, reason: verdict.reason, source });
      return { status: "cooldown", activityCode: activity.code, reason, command: null, reply: null };
    }
  }

  const acceptsNickname = Object.hasOwn(activity.params, "maxNameLength");
  const command = buildActivityCommand(activity, acceptsNickname ? { nick: donation.username } : {});

  try {
    const reply = await deps.apply(command);
    deps.store.record({ ...donation, status: "applied", activityCode: activity.code, reason: null, receivedAt, source });
    log("donation.applied", { id: donation.id, activity: activity.code, amount: donation.amount, command, reply, source });
    if (advanceCursor) deps.store.setLastSeenId(donation.id);
    return { status: "applied", activityCode: activity.code, reason: null, command, reply };
  } catch (error) {
    const reason = (error as Error).message.slice(0, 200);
    deps.store.record({ ...donation, status: "failed", activityCode: activity.code, reason, receivedAt, source });
    log("donation.failed", { id: donation.id, activity: activity.code, error: (error as Error).message, source });
    if (advanceCursor) deps.store.setLastSeenId(donation.id);
    return { status: "failed", activityCode: activity.code, reason, command, reply: null };
  }
}

export async function pollOnce(deps: PollDeps): Promise<PollSummary> {
  const summary: PollSummary = { seen: 0, applied: 0, rejected: 0, cooled: 0, failed: 0, duplicates: 0 };

  const cursor = deps.store.getLastSeenId();
  const incoming = (await deps.fetchDonations(cursor))
    .filter((donation) => donation.id > cursor)
    .sort((left, right) => left.id - right.id);

  for (const donation of incoming) {
    summary.seen += 1;
    const outcome = await processDonation(deps, donation, { advanceCursor: true, source: "da" });
    switch (outcome.status) {
      case "applied": summary.applied += 1; break;
      case "rejected": summary.rejected += 1; break;
      case "cooldown": summary.cooled += 1; break;
      case "failed": summary.failed += 1; break;
      case "duplicate": summary.duplicates += 1; break;
    }
  }

  return summary;
}
