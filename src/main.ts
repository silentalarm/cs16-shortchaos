import { readFileSync } from "node:fs";
import { loadActivities } from "./activities.ts";
import { applyOverrides, OverrideStore } from "./activities-override.ts";
import { createAdminServer } from "./admin/server.ts";
import { CODES_PROBE } from "./command.ts";
import type { DonationRow } from "./db.ts";
import { openStore } from "./db.ts";
import { fetchDonations } from "./donationalerts.ts";
import { loadEnv } from "./env.ts";
import { buildOverlay, writeOverlay } from "./overlay.ts";
import { drainQueue, pollOnce } from "./poller.ts";
import { PendingQueue } from "./queue.ts";
import { RconClient } from "./rcon.ts";
import { TokenStore } from "./token-store.ts";

const env = loadEnv();
const baseCatalog = loadActivities(env.activitiesPath);
// A corrupt override file must stop the process here: silently ignoring it would run a catalogue
// whose prices differ from what the owner sees in the panel.
const overrideStore = new OverrideStore(env.admin.overridePath);
let catalog = applyOverrides(baseCatalog, overrideStore.read());
const store = openStore(env.dbPath);
/**
 * Paid activities that hit a cooldown wait here instead of being rejected. In memory on purpose:
 * a restart loses the waiting list, and the rows stay `queued` in SQLite, which the panel shows.
 */
const queue = new PendingQueue();

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
let admin: import("node:http").Server | null = null;

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

/**
 * Rewrites the text the encoder draws under the picture: last donation and what it bought, the
 * cheapest things a viewer can buy, how many paid activities are waiting. Best effort on purpose -
 * a read-only directory must never stop the donation loop.
 */
function refreshOverlay(): void {
  try {
    writeOverlay(
      env.overlayDir,
      buildOverlay({ recent: store.recent(5), catalog, pending: queue.snapshot(), now: Date.now() }),
    );
  } catch (error) {
    log("overlay.error", { error: (error as Error).message });
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

/**
 * The panel is optional: without ADMIN_TOKEN it simply does not start. That keeps a half-configured
 * deployment from exposing RCON-backed endpoints with an empty password.
 */
function startAdmin(): import("node:http").Server | null {
  if (env.admin.token === "") {
    log("admin.disabled", { hint: "set ADMIN_TOKEN in .env to enable the panel" });
    return null;
  }

  const server = createAdminServer({
    token: env.admin.token,
    publicDir: env.admin.publicDir,
    store,
    getCatalog: () => catalog,
    getBaseCatalog: () => baseCatalog,
    setCatalog: (next) => { catalog = next; },
    overrides: overrideStore,
    apply,
    streamStatusDir: env.admin.streamStatusDir,
    playback: { port: env.admin.hlsPort, path: env.admin.hlsPath },
    mode: { mock: env.mock, dryRun: env.rcon.dryRun, simAllowed: env.admin.simAllowed },
    log,
  });

  server.on("error", (error) => log("admin.error", { message: error.message }));
  server.listen(env.admin.port, env.admin.bind, () => {
    log("admin.listening", {
      url: `http://${env.admin.bind}:${env.admin.port}`,
      simAllowed: env.admin.simAllowed,
      overrides: env.admin.overridePath,
    });
  });
  return server;
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
      // The queue goes first: a viewer who paid a minute ago must not wait behind a fresh poll.
      const drained = await drainQueue({ store, catalog, apply, log, queue });
      if (drained.applied + drained.requeued + drained.failed + drained.expired > 0) {
        log("queue.drained", { ...drained, pending: queue.size });
      }

      const summary = await pollOnce({ store, catalog, fetchDonations: source, apply, log, queue });
      if (summary.seen > 0) log("poll.done", { ...summary });
    } catch (error) {
      log("poll.error", { error: (error as Error).message });
    } finally {
      // In `finally`: a failed poll must not freeze the overlay on an old donation.
      refreshOverlay();
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

  // The panel starts after the first poll so it opens on real state, not on an empty screen.
  admin = startAdmin();

  const timer = setInterval(() => void tick(), env.pollSec * 1000);

  const shutdown = (): void => {
    clearInterval(timer);
    admin?.close();
    rcon?.close();
    store.close();
    log("stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
