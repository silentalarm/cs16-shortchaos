import { readFileSync } from "node:fs";
import { loadActivities } from "./activities.ts";
import { CODES_PROBE } from "./command.ts";
import type { DonationRow } from "./db.ts";
import { openStore } from "./db.ts";
import { fetchDonations } from "./donationalerts.ts";
import { loadEnv } from "./env.ts";
import { pollOnce } from "./poller.ts";
import { RconClient } from "./rcon.ts";
import { TokenStore } from "./token-store.ts";

const env = loadEnv();
const catalog = loadActivities(env.activitiesPath);
const store = openStore(env.dbPath);

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
}

/** Reads donations written by `npm run fake-donation`; no network, no tokens. */
function mockSource(): (cursor: number) => Promise<DonationRow[]> {
  return async (cursor) => {
    try {
      const raw: unknown = JSON.parse(readFileSync(env.mockFile, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (item): item is DonationRow =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as DonationRow).id === "number" &&
          typeof (item as DonationRow).amount === "number" &&
          typeof (item as DonationRow).currency === "string" &&
          typeof (item as DonationRow).username === "string" &&
          (item as DonationRow).id > cursor,
      );
    } catch {
      return [];
    }
  };
}

/** Real donations: refresh the access token five minutes before it dies, then poll. */
function liveSource(clientId: string, clientSecret: string, redirectUri: string): (cursor: number) => Promise<DonationRow[]> {
  const tokens = new TokenStore("data/da-token.json");
  return async (cursor) => {
    const current = tokens.load();
    if (current === null) {
      throw new Error("no DonationAlerts tokens, run `node scripts/oauth-login.ts` once");
    }

    let accessToken = current.accessToken;
    if (tokens.isExpiring(current)) {
      const { refreshTokens } = await import("./donationalerts.ts");
      const refreshed = await refreshTokens({ clientId, clientSecret, redirectUri }, current.refreshToken);
      tokens.save(refreshed);
      accessToken = refreshed.accessToken;
      log("oauth.refreshed");
    }

    const rows = await fetchDonations(accessToken);
    return rows.filter((row) => row.id > cursor);
  };
}

let rcon: RconClient | null = null;

async function apply(command: string): Promise<string> {
  if (env.rcon.dryRun) {
    log("rcon.dry_run", { command });
    return "dry-run";
  }
  if (rcon === null) {
    rcon = await RconClient.connect({
      host: env.rcon.host,
      port: env.rcon.port,
      password: env.rcon.password,
      timeoutMs: env.rcon.timeoutMs,
    });
  }
  try {
    return await rcon.exec(command);
  } catch (error) {
    rcon.close();
    rcon = null;
    throw error;
  }
}

async function checkPluginContract(): Promise<void> {
  if (env.rcon.dryRun) return;
  try {
    const reply = await apply(CODES_PROBE);
    const supported = new Set(reply.split(/[\s,]+/).filter(Boolean));
    const missing = catalog.activities.filter((activity) => !supported.has(activity.code)).map((activity) => activity.code);
    if (missing.length > 0) {
      log("plugin.contract_mismatch", { missing, hint: "activities exist in the catalogue but not in the Pawn plugin" });
    } else {
      log("plugin.contract_ok", { activities: catalog.activities.length });
    }
  } catch (error) {
    log("plugin.contract_failed", { error: (error as Error).message });
  }
}

async function main(): Promise<void> {
  const source = env.mock ? mockSource() : liveSource(env.da.clientId, env.da.clientSecret, env.da.redirectUri);
  log("started", {
    mock: env.mock,
    dryRun: env.rcon.dryRun,
    pollSec: env.pollSec,
    activities: catalog.activities.length,
    cursor: store.getLastSeenId(),
  });
  await checkPluginContract();

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const summary = await pollOnce({ store, catalog, fetchDonations: source, apply, log });
      if (summary.seen > 0) log("poll.done", { ...summary });
    } catch (error) {
      log("poll.error", { error: (error as Error).message });
    } finally {
      running = false;
    }
  };

  await tick();

  // POLL_ONCE=1 turns the daemon into a single pass: used by smoke runs and by CI.
  if (process.env["POLL_ONCE"] === "1") {
    rcon?.close();
    store.close();
    log("stopped", { once: true });
    process.exit(0);
  }

  const timer = setInterval(() => void tick(), env.pollSec * 1000);

  const shutdown = (): void => {
    clearInterval(timer);
    rcon?.close();
    store.close();
    log("stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
