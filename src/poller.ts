import type { ActivitiesConfig, Activity } from "./activities.ts";
import { buildActivityCommand } from "./command.ts";
import type { CommandOptions } from "./command.ts";
import { checkCooldown, msFromIso } from "./cooldowns.ts";
import type { DonationRow, DonationSource, DonationStatus, Store } from "./db.ts";
import { resolveDonation } from "./mapping.ts";
import type { PendingQueue } from "./queue.ts";

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
  /**
   * Holds paid activities that hit a cooldown. Without a queue (the admin panel, most tests) a
   * cooldown keeps the old verdict: the donation is recorded as `cooldown` and nothing runs.
   */
  queue?: PendingQueue;
  now?: () => number;
  log?: (event: string, details?: Record<string, unknown>) => void;
  /** Currency table override, RUB per unit; the admin panel and tests leave it at the defaults. */
  rates?: Record<string, number>;
  /** Which effect one 50 RUB step buys; a test pins it, production leaves it random. */
  random?: () => number;
  /**
   * Called once per applied activity with the catalogue entry: this is where the announcement voice
   * lives (`src/voice.ts`). Optional and never fatal - a stream must survive a missing audio channel.
   */
  voice?: (activities: readonly Activity[], donation: DonationRow) => void;
}

export interface PollSummary {
  seen: number;
  applied: number;
  rejected: number;
  cooled: number;
  /** Paid activities parked until their cooldown window opens (see `src/queue.ts`). */
  queued: number;
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

  const resolution = resolveDonation(
    { amount: donation.amount, currency: donation.currency, message: donation.message ?? null },
    deps.catalog,
    {
      ...(deps.rates === undefined ? {} : { rates: deps.rates }),
      ...(deps.random === undefined ? {} : { random: deps.random }),
    },
  );
  if (resolution.kind === "reject") {
    deps.store.record({ ...donation, status: "rejected", activityCode: null, reason: resolution.reason, receivedAt, source });
    if (advanceCursor) deps.store.setLastSeenId(donation.id);
    log("donation.rejected", { id: donation.id, amount: donation.amount, reason: resolution.reason, source });
    return { status: "rejected", activityCode: null, reason: resolution.reason, command: null, reply: null };
  }

  if (resolution.droppedUnits > 0) {
    // Only reachable with an absurd amount (MAX_UNITS * 50 RUB). Logged, never silent.
    log("donation.units_capped", { id: donation.id, units: resolution.units, dropped: resolution.droppedUnits, source });
  }

  const plan = resolution.activities;
  const activityCode = [...new Set(plan.map((activity) => activity.code))].join("+");

  // Every line is built before anything is sent: a broken param must not leave the first effect
  // applied and the rest of the purchase unbuilt.
  const commands: { activity: Activity; command: string }[] = [];
  for (const activity of plan) {
    const commandOptions: CommandOptions = {};
    if (Object.hasOwn(activity.params, "maxNameLength")) commandOptions.nick = donation.username;
    if (Object.hasOwn(activity.params, "maxPhraseLength")) commandOptions.message = donation.message ?? "";
    let command: string;
    try {
      command = buildActivityCommand(activity, commandOptions);
    } catch (error) {
      // A catalogue entry with a broken param must not escape as an unhandled exception: the money
      // is already paid, so it gets a row that says why nothing happened.
      const reason = `invalid_params:${(error as Error).message}`.slice(0, 200);
      deps.store.record({ ...donation, status: "rejected", activityCode, reason, receivedAt, source });
      if (advanceCursor) deps.store.setLastSeenId(donation.id);
      log("donation.rejected", { id: donation.id, activity: activity.code, reason, source });
      return { status: "rejected", activityCode, reason, command: null, reply: null };
    }
    commands.push({ activity, command });
  }

  const line = commands.map((item) => item.command).join(" & ");

  const runnable: { activity: Activity; command: string }[] = [];
  let blocked: { activity: Activity; command: string; reason: string; retryAfterSec: number } | null = null;

  if (options.bypassCooldown) {
    runnable.push(...commands);
  } else {
    for (const item of commands) {
      const verdict = checkCooldown({
        activity: item.activity,
        now: timestamp,
        lastAppliedByDonor: msFromIso(deps.store.lastAppliedByDonor(donation.username)),
        lastAppliedByActivity: msFromIso(deps.store.lastAppliedByActivity(item.activity.code)),
      });

      if (verdict.allowed) {
        runnable.push(item);
        continue;
      }

      // The viewer paid: the first parked line waits for its window instead of being thrown away.
      // A second blocked line of the same donation is reported in the log and the history row.
      if (blocked === null) blocked = { ...item, reason: verdict.reason, retryAfterSec: verdict.retryAfterSec };
      else log("donation.cooldown_dropped", { id: donation.id, activity: item.activity.code, reason: verdict.reason, source });
    }
  }

  let reply: string | null = null;
  for (const item of runnable) {
    try {
      reply = await deps.apply(item.command);
    } catch (error) {
      const reason = (error as Error).message.slice(0, 200);
      deps.store.record({ ...donation, status: "failed", activityCode, reason, receivedAt, source });
      log("donation.failed", { id: donation.id, activity: item.activity.code, error: reason, source });
      if (advanceCursor) deps.store.setLastSeenId(donation.id);
      return { status: "failed", activityCode, reason, command: line, reply: null };
    }
  }

  // One announcement per donation, not per activity: a big sum buys a batch, and six beds and six
  // spoken lines inside one second talk over each other instead of crediting anybody.
  if (deps.voice !== undefined && runnable.length > 0) {
    try {
      deps.voice(runnable.map((item) => item.activity), donation);
    } catch (error) {
      log("voice.failed", {
        activities: runnable.map((item) => item.activity.code).join("+"),
        error: (error as Error).message,
      });
    }
  }

  if (blocked !== null) {
    const reason = `${blocked.reason}:${blocked.retryAfterSec}s`;

    if (deps.queue !== undefined) {
      const evicted = deps.queue.add({
        donationId: donation.id,
        username: donation.username,
        amount: donation.amount,
        source,
        activityCode: blocked.activity.code,
        command: blocked.command,
        reason: blocked.reason,
        enqueuedAt: timestamp,
        dueAt: timestamp + blocked.retryAfterSec * 1000,
      });

      if (evicted !== null) {
        deps.store.updateStatus(evicted.donationId, "expired", "queue_evicted");
        log("queue.evicted", { id: evicted.donationId, activity: evicted.activityCode, source: evicted.source });
      }

      deps.store.record({ ...donation, status: "queued", activityCode, reason, receivedAt, source });
      if (advanceCursor) deps.store.setLastSeenId(donation.id);
      log("donation.queued", {
        id: donation.id,
        activity: blocked.activity.code,
        reason: blocked.reason,
        dueInSec: blocked.retryAfterSec,
        appliedNow: runnable.length,
        source,
      });
      return { status: "queued", activityCode, reason, command: line, reply };
    }

    deps.store.record({ ...donation, status: "cooldown", activityCode, reason, receivedAt, source });
    if (advanceCursor) deps.store.setLastSeenId(donation.id);
    log("donation.cooldown", { id: donation.id, activity: blocked.activity.code, reason: blocked.reason, source });
    return { status: "cooldown", activityCode, reason, command: line, reply };
  }

  deps.store.record({ ...donation, status: "applied", activityCode, reason: null, receivedAt, source });
  log("donation.applied", {
    id: donation.id,
    activity: activityCode,
    // How many 50 RUB steps the donation bought, and what the catalogue saw after conversion.
    units: resolution.units,
    amount: donation.amount,
    currency: donation.currency,
    chargedRub: resolution.amount,
    command: line,
    reply,
    source,
  });
  if (advanceCursor) deps.store.setLastSeenId(donation.id);
  return { status: "applied", activityCode, reason: null, command: line, reply };
}

export async function pollOnce(deps: PollDeps): Promise<PollSummary> {
  const summary: PollSummary = { seen: 0, applied: 0, rejected: 0, cooled: 0, queued: 0, failed: 0, duplicates: 0 };

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
      case "queued": summary.queued += 1; break;
      case "failed": summary.failed += 1; break;
      case "duplicate": summary.duplicates += 1; break;
    }
  }

  return summary;
}

export interface DrainSummary {
  applied: number;
  requeued: number;
  failed: number;
  expired: number;
}

/**
 * Rebuilds the in-memory queue from the `queued` rows in SQLite.
 *
 * Runs once at startup, before the first tick. The command is rebuilt with the same builder the live
 * path uses, so a restored entry sends exactly what it would have sent; `enqueuedAt` keeps the
 * original `received_at`, which means `maxWaitMs` still applies and an entry that waited out its
 * window while the container was down is reported as expired instead of firing hours late.
 */
export function restoreQueue(deps: DonationDeps, now = Date.now()): number {
  const queue = deps.queue;
  if (queue === undefined) return 0;

  const log = deps.log ?? (() => {});
  let restored = 0;

  for (const row of deps.store.queuedDonations()) {
    if (queue.has(row.id)) continue;

    // A row may carry several codes ("he_party+bounty") when one donation bought more than one
    // effect; the queue holds one line, so the first one is restored.
    const code = row.activityCode === undefined || row.activityCode === null ? null : row.activityCode.split("+")[0];
    const activity = code === null || code === undefined
      ? undefined
      : deps.catalog.activities.find((item) => item.code === code);
    if (activity === undefined) {
      deps.store.updateStatus(row.id, "failed", "activity_disabled");
      log("donation.restore_failed", { id: row.id, activity: row.activityCode, reason: "activity_disabled" });
      continue;
    }

    const options: CommandOptions = {};
    if (Object.hasOwn(activity.params, "maxNameLength")) options.nick = row.username;
    if (Object.hasOwn(activity.params, "maxPhraseLength")) options.message = row.message ?? "";

    let command: string;
    try {
      command = buildActivityCommand(activity, options);
    } catch (error) {
      const reason = `invalid_params:${(error as Error).message}`.slice(0, 200);
      deps.store.updateStatus(row.id, "failed", reason);
      log("donation.restore_failed", { id: row.id, activity: activity.code, reason });
      continue;
    }

    const receivedAt = Date.parse(row.receivedAt);
    const evicted = queue.add({
      donationId: row.id,
      username: row.username,
      amount: row.amount,
      source: row.source ?? "da",
      activityCode: activity.code,
      command,
      reason: "restored",
      enqueuedAt: Number.isFinite(receivedAt) ? receivedAt : now,
      // Ready immediately: drainQueue re-checks the cooldown and postpones the entry if the window
      // is still closed, so no retry timestamp has to survive the restart as well.
      dueAt: now,
    });

    if (evicted !== null) {
      deps.store.updateStatus(evicted.donationId, "expired", "queue_evicted");
      log("queue.evicted", { id: evicted.donationId, activity: evicted.activityCode, source: evicted.source });
    }

    log("donation.restored", { id: row.id, activity: activity.code, command, source: row.source ?? "da" });
    restored += 1;
  }

  return restored;
}

/**
 * Applies the paid activities whose cooldown window has opened.
 *
 * Runs before the poll, so a waiting donation is not stuck behind fresh ones, and it re-checks the
 * cooldown at apply time: while the entry waited, other donations may have put the same activity
 * back on cooldown, and two `map_change` commands minutes apart would restart the map twice.
 */
export async function drainQueue(deps: DonationDeps, now?: number): Promise<DrainSummary> {
  const summary: DrainSummary = { applied: 0, requeued: 0, failed: 0, expired: 0 };
  const queue = deps.queue;
  if (queue === undefined) return summary;

  const log = deps.log ?? (() => {});
  const timestamp = now ?? (deps.now ?? (() => Date.now()))();
  const { ready, expired } = queue.due(timestamp);

  for (const entry of expired) {
    deps.store.updateStatus(entry.donationId, "expired", "queue_expired");
    log("donation.queue_expired", {
      id: entry.donationId,
      activity: entry.activityCode,
      waitedSec: Math.round((timestamp - entry.enqueuedAt) / 1000),
    });
    summary.expired += 1;
  }

  for (const candidate of ready) {
    const activity = deps.catalog.activities.find((item) => item.code === candidate.activityCode);

    if (activity === undefined) {
      if (queue.take(candidate.donationId) === null) continue;
      deps.store.updateStatus(candidate.donationId, "failed", "activity_disabled");
      log("donation.queue_failed", { id: candidate.donationId, activity: candidate.activityCode, reason: "activity_disabled" });
      summary.failed += 1;
      continue;
    }

    const verdict = checkCooldown({
      activity,
      now: timestamp,
      lastAppliedByDonor: msFromIso(deps.store.lastAppliedByDonor(candidate.username)),
      lastAppliedByActivity: msFromIso(deps.store.lastAppliedByActivity(activity.code)),
    });

    if (!verdict.allowed) {
      queue.postpone(candidate.donationId, timestamp + verdict.retryAfterSec * 1000, verdict.reason);
      summary.requeued += 1;
      continue;
    }

    const entry = queue.take(candidate.donationId);
    if (entry === null) continue;

    try {
      const reply = await deps.apply(entry.command);
      deps.store.updateStatus(entry.donationId, "applied", null);
      log("donation.dequeued", {
        id: entry.donationId,
        activity: entry.activityCode,
        amount: entry.amount,
        waitedSec: Math.round((timestamp - entry.enqueuedAt) / 1000),
        command: entry.command,
        reply,
      });
      summary.applied += 1;
    } catch (error) {
      const reason = (error as Error).message.slice(0, 200);
      deps.store.updateStatus(entry.donationId, "failed", reason);
      log("donation.queue_failed", { id: entry.donationId, activity: entry.activityCode, error: reason });
      summary.failed += 1;
    }
  }

  return summary;
}
