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

/**
 * Where a row came from. `da` is a real DonationAlerts donation; `sim` is a donation injected
 * from the admin panel while debugging. The difference matters in two places: the simulator must
 * never move the real poll cursor, and its rows can be wiped with one button.
 */
export type DonationSource = "da" | "sim";

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
  source?: DonationSource;
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
  received_at   TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'da'
);
CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations (username, received_at);
CREATE INDEX IF NOT EXISTS idx_donations_activity ON donations (activity_code, received_at);
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_actions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  code    TEXT,
  params  TEXT,
  command TEXT,
  reply   TEXT
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
    this.#migrate();
  }

  /**
   * Databases created before the `source` column existed are upgraded in place: recreating the
   * table would throw away the donation history that cooldowns are computed from.
   */
  #migrate(): void {
    const columns = this.#db.prepare("PRAGMA table_info(donations)").all() as unknown as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("source")) {
      this.#db.exec("ALTER TABLE donations ADD COLUMN source TEXT NOT NULL DEFAULT 'da'");
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Returns false when this donation id was already stored (duplicate delivery). */
  record(donation: StoredDonation): boolean {
    const statement = this.#db.prepare(`
      INSERT OR IGNORE INTO donations
        (id, username, amount, currency, message, created_at, status, activity_code, reason, received_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      donation.source ?? "da",
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
               status, activity_code AS activityCode, reason, received_at AS receivedAt, source
        FROM donations ORDER BY received_at DESC, id DESC LIMIT ?
      `)
      .all(limit) as unknown as StoredDonation[];
    return rows;
  }

  /**
   * Deletes rows produced by the admin simulator. Real donations are untouched: wiping them would
   * reset the cooldown history and let a troll buy the same activity twice in a row.
   */
  resetSim(): number {
    const result = this.#db.prepare("DELETE FROM donations WHERE source = 'sim'").run();
    return Number(result.changes);
  }

  /**
   * Every command the panel sends to the game server is written here, with the exact RCON line and
   * the reply. The panel is the only human-driven path into RCON, so this table is the audit trail
   * that explains a strange round afterwards ("who started knives_only at 21:14?").
   */
  recordAdminAction(action: AdminActionInput): number {
    const result = this.#db
      .prepare("INSERT INTO admin_actions (at, kind, code, params, command, reply) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        action.at,
        action.kind,
        action.code ?? null,
        action.params === undefined ? null : JSON.stringify(action.params),
        action.command ?? null,
        action.reply ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  recentAdminActions(limit = 10): AdminAction[] {
    const rows = this.#db
      .prepare("SELECT id, at, kind, code, params, command, reply FROM admin_actions ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as AdminAction[];
    return rows;
  }
}

export interface AdminActionInput {
  at: string;
  /** trigger | clear | override | settings | sim_reset */
  kind: string;
  code?: string | null;
  params?: Record<string, unknown>;
  command?: string | null;
  reply?: string | null;
}

export interface AdminAction {
  id: number;
  at: string;
  kind: string;
  code: string | null;
  params: string | null;
  command: string | null;
  reply: string | null;
}

export function openStore(path: string): Store {
  return new Store(path);
}
