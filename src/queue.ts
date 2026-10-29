import type { DonationSource } from "./db.ts";

/**
 * Paid activities that cannot run right now.
 *
 * A donation that hits a cooldown used to be rejected: the viewer paid and saw nothing, and the
 * most generous donation of the evening was the one most likely to be dropped. It is queued
 * instead and applied as soon as the window opens.
 *
 * Two limits keep the queue from turning into a backlog nobody wants: entries expire
 * (`maxWaitMs`, a map change forty minutes late is worse than none) and the queue is bounded
 * (`maxEntries`). The queue itself is in memory — after a restart the rows stay `queued` in
 * SQLite, which the panel shows, so a dropped entry is visible instead of silent.
 */
export interface PendingActivity {
  donationId: number;
  username: string;
  amount: number;
  source: DonationSource;
  activityCode: string;
  /** The RCON line is built once, at donation time: the price the viewer paid is what runs. */
  command: string;
  /** Cooldown reason that pushed the entry into the queue, kept for the log. */
  reason: string;
  enqueuedAt: number;
  dueAt: number;
}

/**
 * Room for an honest burst: at 32 a spike of small donations evicted the earliest entrants, and an
 * evicted row is money taken for an effect nobody ever saw. The bound stays so a runaway queue
 * cannot grow without limit - eviction is the last resort now, not the normal path.
 */
export const DEFAULT_MAX_ENTRIES = 256;
export const DEFAULT_MAX_WAIT_MS = 15 * 60_000;

export interface QueueOptions {
  maxEntries?: number;
  /** How long a paid activity may wait before it is dropped and marked expired. */
  maxWaitMs?: number;
}

export interface DueResult {
  /** Entries whose wait is over; the caller applies or postpones them. */
  ready: PendingActivity[];
  /** Entries that waited too long and were removed. */
  expired: PendingActivity[];
}

/**
 * FIFO by due time. Order matters: when several paid activities are waiting, the one whose
 * cooldown expired first runs first, and the queue never reorders by amount — a 50 RUB donation
 * is not starved by a 500 RUB one.
 */
export class PendingQueue {
  readonly #entries = new Map<number, PendingActivity>();
  readonly #maxEntries: number;
  readonly #maxWaitMs: number;

  constructor(options: QueueOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.#maxWaitMs = Math.max(0, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Adds an entry. The oldest entry is evicted when the queue is full, and returned so the caller
   * can mark that row expired: dropping a paid activity silently is exactly what this queue exists
   * to prevent.
   */
  add(entry: PendingActivity): PendingActivity | null {
    const existing = this.#entries.get(entry.donationId);
    if (existing !== undefined) {
      this.#entries.set(entry.donationId, { ...existing, dueAt: entry.dueAt, reason: entry.reason });
      return null;
    }

    let evicted: PendingActivity | null = null;
    if (this.#entries.size >= this.#maxEntries) {
      const [oldestId, oldest] = this.#entries.entries().next().value as [number, PendingActivity];
      this.#entries.delete(oldestId);
      evicted = oldest;
    }

    this.#entries.set(entry.donationId, entry);
    return evicted;
  }

  /** Removes and returns one entry, used right before applying it. */
  take(donationId: number): PendingActivity | null {
    const entry = this.#entries.get(donationId);
    if (entry === undefined) return null;
    this.#entries.delete(donationId);
    return entry;
  }

  /** Pushes the entry back with a later due time; `enqueuedAt` stays, so ageing still applies. */
  postpone(donationId: number, dueAt: number, reason: string): boolean {
    const entry = this.#entries.get(donationId);
    if (entry === undefined) return false;
    this.#entries.set(donationId, { ...entry, dueAt, reason });
    return true;
  }

  has(donationId: number): boolean {
    return this.#entries.has(donationId);
  }

  /** Ready entries (oldest due time first) and expired ones, which are removed here. */
  due(now: number): DueResult {
    const ready: PendingActivity[] = [];
    const expired: PendingActivity[] = [];

    for (const [donationId, entry] of this.#entries) {
      if (now - entry.enqueuedAt > this.#maxWaitMs) {
        this.#entries.delete(donationId);
        expired.push(entry);
      } else if (entry.dueAt <= now) {
        ready.push(entry);
      }
    }

    ready.sort((left, right) => left.dueAt - right.dueAt || left.donationId - right.donationId);
    return { ready, expired };
  }

  /** Read-only copy for the panel and the logs; the queue itself is never handed out. */
  snapshot(): PendingActivity[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }
}
