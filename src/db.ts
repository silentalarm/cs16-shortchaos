import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Donation history and dedup state.
 *
 * The DonationAlerts API gives no delivery guarantee: the poller may see the same
 * donation twice (restart, overlapping polls), so the donation id is the primary key
 * and `record()` reports whether the row is new.
 */
export type DonationStatus = "applied" | "rejected" | "cooldown" | "failed";

export interface DonationRow {
  id: number;
  username: string;
  amount: number;
  currency: string;
  message?: string | null;
  createdAt?: string | null;
}

export interface StoredDonation extends DonationRow {
  status: DonationStatus;
  activityCode?: string | null;
  reason?: string | null;
  receivedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS donations (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL,
  amount        REAL    NOT NULL,
  currency      TEXT    NOT NULL,
  message       TEXT,
  created_at    TEXT,
  status        TEXT    NOT NULL,
  activity_code TEXT,
  reason        TEXT,
  received_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations (username, received_at);
CREATE INDEX IF NOT EXISTS idx_donations_activity ON donations (activity_code, received_at);
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  /** Returns false when this donation id was already stored (duplicate delivery). */
  record(donation: StoredDonation): boolean {
    const statement = this.#db.prepare(`
      INSERT OR IGNORE INTO donations
        (id, username, amount, currency, message, created_at, status, activity_code, reason, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = statement.run(
      donation.id,
      donation.username,
      donation.amount,
      donation.currency,
      donation.message ?? null,
      donation.createdAt ?? null,
      donation.status,
      donation.activityCode ?? null,
      donation.reason ?? null,
      donation.receivedAt,
    );
    return result.changes > 0;
  }

  has(id: number): boolean {
    const row = this.#db.prepare("SELECT 1 AS found FROM donations WHERE id = ?").get(id);
    return row !== undefined;
  }

  getState(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.#db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getLastSeenId(): number {
    const raw = this.getState("donations.last_seen_id");
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  setLastSeenId(id: number): void {
    this.setState("donations.last_seen_id", String(id));
  }

  /** ISO timestamp of the last applied activity for this donor, null when never applied. */
  lastAppliedByDonor(username: string): string | null {
    const row = this.#db
      .prepare("SELECT MAX(received_at) AS at FROM donations WHERE username = ? AND status = 'applied'")
      .get(username) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /** ISO timestamp of the last applied run of this activity, null when never applied. */
  lastAppliedByActivity(code: string): string | null {
    const row = this.#db
      .prepare("SELECT MAX(received_at) AS at FROM donations WHERE activity_code = ? AND status = 'applied'")
      .get(code) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  recent(limit = 20): StoredDonation[] {
    const rows = this.#db
      .prepare(`
        SELECT id, username, amount, currency, message, created_at AS createdAt,
               status, activity_code AS activityCode, reason, received_at AS receivedAt
        FROM donations ORDER BY received_at DESC, id DESC LIMIT ?
      `)
      .all(limit) as unknown as StoredDonation[];
    return rows;
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
