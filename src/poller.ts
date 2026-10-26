import type { ActivitiesConfig } from "./activities.ts";
import { buildActivityCommand } from "./command.ts";
import { checkCooldown, msFromIso } from "./cooldowns.ts";
import type { DonationRow, Store } from "./db.ts";
import { resolveDonation } from "./mapping.ts";

/**
 * One polling pass: fetch, dedup, map to an activity, respect cooldowns, apply through RCON,
 * persist the verdict. Every donation ends up in the database with a status, so a rejected
 * donation can be explained later instead of vanishing.
 */
export interface PollDeps {
  store: Store;
  catalog: ActivitiesConfig;
  /** Returns donations; the poller itself ignores ids <= cursor. */
  fetchDonations: (cursor: number) => Promise<DonationRow[]>;
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

export async function pollOnce(deps: PollDeps): Promise<PollSummary> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const summary: PollSummary = { seen: 0, applied: 0, rejected: 0, cooled: 0, failed: 0, duplicates: 0 };

  const cursor = deps.store.getLastSeenId();
  const incoming = (await deps.fetchDonations(cursor))
    .filter((donation) => donation.id > cursor)
    .sort((left, right) => left.id - right.id);

  for (const donation of incoming) {
    summary.seen += 1;
    const timestamp = now();
    const receivedAt = new Date(timestamp).toISOString();

    if (deps.store.has(donation.id)) {
      summary.duplicates += 1;
      deps.store.setLastSeenId(donation.id);
      continue;
    }

    const resolution = resolveDonation({ amount: donation.amount, currency: donation.currency }, deps.catalog);
    if (resolution.kind === "reject") {
      summary.rejected += 1;
      deps.store.record({
        ...donation,
        status: "rejected",
        activityCode: null,
        reason: resolution.reason,
        receivedAt,
      });
      deps.store.setLastSeenId(donation.id);
      log("donation.rejected", { id: donation.id, amount: donation.amount, reason: resolution.reason });
      continue;
    }

    const activity = resolution.activity;
    const verdict = checkCooldown({
      activity,
      now: timestamp,
      lastAppliedByDonor: msFromIso(deps.store.lastAppliedByDonor(donation.username)),
      lastAppliedByActivity: msFromIso(deps.store.lastAppliedByActivity(activity.code)),
    });

    if (!verdict.allowed) {
      summary.cooled += 1;
      deps.store.record({
        ...donation,
        status: "cooldown",
        activityCode: activity.code,
        reason: `${verdict.reason}:${verdict.retryAfterSec}s`,
        receivedAt,
      });
      deps.store.setLastSeenId(donation.id);
      log("donation.cooldown", { id: donation.id, activity: activity.code, reason: verdict.reason });
      continue;
    }

    const acceptsNickname = Object.hasOwn(activity.params, "maxNameLength");
    const command = buildActivityCommand(activity, acceptsNickname ? { nick: donation.username } : {});

    try {
      const reply = await deps.apply(command);
      summary.applied += 1;
      deps.store.record({
        ...donation,
        status: "applied",
        activityCode: activity.code,
        reason: null,
        receivedAt,
      });
      log("donation.applied", { id: donation.id, activity: activity.code, amount: donation.amount, command, reply });
    } catch (error) {
      summary.failed += 1;
      deps.store.record({
        ...donation,
        status: "failed",
        activityCode: activity.code,
        reason: (error as Error).message.slice(0, 200),
        receivedAt,
      });
      log("donation.failed", { id: donation.id, activity: activity.code, error: (error as Error).message });
    }

    deps.store.setLastSeenId(donation.id);
  }

  return summary;
}
