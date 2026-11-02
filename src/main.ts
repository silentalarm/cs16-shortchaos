import { readFileSync } from "node:fs";
import { loadActivities } from "./activities.ts";
import type { Activity } from "./activities.ts";
import { applyOverrides, OverrideStore } from "./activities-override.ts";
import { createAdminServer } from "./admin/server.ts";
import { AutoRotation, chaosCodeAt, loadAutoEvents, type AutoCursor } from "./auto-events.ts";
import { addToChaos, CHAOS_THRESHOLD } from "./chaos-meter.ts";
import { buildActivityCommand, CODES_PROBE, sanitizePhrase } from "./command.ts";
import type { DonationRow } from "./db.ts";
import { openStore } from "./db.ts";
import { fetchDonations } from "./donationalerts.ts";
import { loadEnv } from "./env.ts";
import { GamePoller } from "./game-poller.ts";
import { buildOverlay, writeOverlay } from "./overlay.ts";
import { drainQueue, pollOnce, restoreQueue } from "./poller.ts";
import { announcementFor, countdownCues, donationAnnouncement, phaseCues, quoteRequest, silenceRequest, writeVoiceRequest } from "./voice.ts";
import { PendingQueue } from "./queue.ts";
import { RconClient } from "./rcon.ts";
import { parsePluginCodes, parsePluginStatus } from "./stream-status.ts";
import { TokenStore } from "./token-store.ts";
import { UiLoop } from "./ui/loop.ts";
import { buildUiState, type UiState } from "./ui/state.ts";
import { STATUS_COMMAND } from "./admin/state.ts";

const env = loadEnv();
const baseCatalog = loadActivities(env.activitiesPath);
// A corrupt override file must stop the process here: silently ignoring it would run a catalogue
// whose prices differ from what the owner sees in the panel.
const overrideStore = new OverrideStore(env.admin.overridePath);
let catalog = applyOverrides(baseCatalog, overrideStore.read());
/**
 * The free rotation (`config/auto-events.json`): one paid-style activity every few minutes, on the
 * house. Read once at startup against the shipped catalogue; the override file only changes prices
 * and params, not which codes exist.
 */
const autoEvents = loadAutoEvents(env.autoEventsPath, baseCatalog);
const store = openStore(env.dbPath);
/**
 * Paid activities that hit a cooldown wait here instead of being rejected. The entries themselves are
 * in memory, but the rows stay `queued` in SQLite and are restored at startup (see `restoreQueue`),
 * so a restart delays a paid activity instead of losing it.
 */
const queue = new PendingQueue();

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
}

/**
 * The announcement voice: a request file the capture container speaks into the broadcast
 * (`infra/stream/voice.sh`). Text never goes to the game - RCON cannot carry spaces or Cyrillic.
 */
const voice = (
  activities: readonly Activity[],
  donation?: { username: string; amount: number; currency: string; message?: string | null },
): void => {
  const first = activities[0];
  if (first === undefined) return;

  // An event whose sound belongs to a rhythm or a phase (`announcer_countdown`, `red_light`) gets one
  // request per cue, mirroring the plugin's timing, and no bed of its own: the cues are its soundtrack.
  // The previous bed is cut first, otherwise the duel's music plays on underneath the new cues.
  const cuesOf = (activity: Activity) => [...phaseCues(activity), ...countdownCues(activity)];
  const phaseOnly = activities.every((activity) => cuesOf(activity).length > 0);
  if (phaseOnly) {
    try {
      writeVoiceRequest(env.overlayDir, { musicStop: true });
    } catch (error) {
      log("voice.failed", { error: (error as Error).message });
    }
  }

  for (const activity of activities) {
    for (const cue of cuesOf(activity)) {
      setTimeout(() => {
        try {
          writeVoiceRequest(env.overlayDir, cue.request);
        } catch (error) {
          log("voice.failed", { error: (error as Error).message });
        }
      }, Math.max(0, cue.at - Date.now())).unref();
    }
  }

  if (phaseOnly) return;

  // The bed of the batch and nothing spoken: the narrator is gone (see `announcementFor`). A panel run has
  // no donor, and both paths now write the same kind of request - music, a cue, and the clock to cut it at.
  writeVoiceRequest(
    env.overlayDir,
    donation === undefined ? announcementFor(first) : donationAnnouncement(activities),
  );

  // `quotes_pack` is a line the viewer paid to hear, in the same ASCII form the chat shows. The raw
  // message may be Cyrillic, and a spoken line that differs from its subtitle reads as a bug, so both
  // go through `sanitizePhrase`. A panel run carries no message: the plugin then uses its own pack and
  // the catalogue line is what the voice says.
  const quote = activities.find((activity) => activity.code === "quotes_pack");
  const raw = donation?.message ?? "";
  if (quote !== undefined && raw.trim() !== "") {
    const limit = typeof quote.params["maxPhraseLength"] === "number" ? quote.params["maxPhraseLength"] : 40;
    const phrase = sanitizePhrase(raw, limit);
    if (phrase !== "") {
      try {
        writeVoiceRequest(env.overlayDir, quoteRequest(phrase));
      } catch (error) {
        log("voice.failed", { error: (error as Error).message });
      }
    }
  }
};

/** The Stop button: kill the bed so the board and the mix are cleared together. */
const silence = (): void => {
  try {
    writeVoiceRequest(env.overlayDir, silenceRequest());
  } catch (error) {
    log("voice.failed", { error: (error as Error).message });
  }
};

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

/** Where `npm run oauth-login` leaves the tokens; `data/` is gitignored. */
const DA_TOKEN_PATH = "data/da-token.json";

/** Real donations: refresh the access token five minutes before it dies, then poll. */
function liveSource(clientId: string, clientSecret: string, redirectUri: string): (cursor: number) => Promise<DonationRow[]> {
  const tokens = new TokenStore(DA_TOKEN_PATH);
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

    const rows = await fetchDonations(accessToken, fetch, { cursor });
    return rows.filter((row) => row.id > cursor);
  };
}

let rcon: RconClient | null = null;
let admin: import("node:http").Server | null = null;
let uiLoop: UiLoop | null = null;

async function ensureRcon(): Promise<RconClient> {
  if (rcon === null) {
    rcon = await RconClient.connect({
      host: env.rcon.host,
      port: env.rcon.port,
      password: env.rcon.password,
      timeoutMs: env.rcon.timeoutMs,
    });
  }
  return rcon;
}

/** One command on the shared connection; a dead socket is dropped so the next call reconnects. */
async function execRcon(command: string): Promise<string> {
  const client = await ensureRcon();
  try {
    return await client.exec(command);
  } catch (error) {
    client.close();
    rcon = null;
    throw error;
  }
}

async function apply(command: string): Promise<string> {
  if (env.rcon.dryRun) {
    log("rcon.dry_run", { command });
    return "dry-run";
  }
  return execRcon(command);
}

/**
 * When a paid command last reached the game.
 *
 * The free rotation steps aside for `quietAfterPaidSec` after this moment: a viewer who paid 50 RUB
 * must not watch a free `he_party` overwrite the effect they just bought. Only the paid paths go
 * through `applyPaid` - the operator panel and the chaos burst are not donations.
 */
let lastPaidAt: number | null = null;

async function applyPaid(command: string): Promise<string> {
  const reply = await apply(command);
  lastPaidAt = Date.now();
  return reply;
}

/**
 * A read-only RCON call for the panel poller. Silent in a dry run: the poller fires twice a second
 * and a log line per poll would bury everything else.
 */
async function readConsole(command: string): Promise<string> {
  if (env.rcon.dryRun) return "";
  return execRcon(command);
}

const gamePoller = new GamePoller({ exec: readConsole, log });

/**
 * The donation side of the panel, refreshed once per poll cycle instead of on every UI tick: the
 * loop runs at 5 Hz and SQLite does not need to be asked the same question five times a second for
 * a 24/7 stream.
 */
let uiRecent: ReturnType<typeof store.recent> = [];
let uiPending: ReturnType<typeof queue.snapshot> = [];

function refreshUiInputs(): void {
  uiRecent = store.recent(5);
  uiPending = queue.snapshot();
}

/**
 * The chaos meter: donated money collected toward the next forced effect.
 *
 * The state lives in SQLite, not in memory: `chaos.total` (roubles on the bar) and the cursor
 * `(chaos.last_at, chaos.last_id)` - the last applied row that was counted. The meter is topped up
 * from the rows themselves, so a crash between applying an effect and counting the money is repaired
 * by the next tick, and a queue drain - which writes an `applied` row too - is counted exactly once.
 */
let chaosTotal = Number.parseFloat(store.getState("chaos.total") ?? "0");
if (!Number.isFinite(chaosTotal) || chaosTotal < 0) chaosTotal = 0;

/**
 * How many bursts already fired. The chaos list is walked in order, so the burst after `he_party` is
 * a meteor shower and the rotation is predictable for a viewer who has watched for ten minutes.
 */
let chaosBursts = Number.parseInt(store.getState("chaos.bursts") ?? "0", 10) || 0;

let chaosCursor = {
  at: store.getState("chaos.last_at") ?? "",
  id: Number.parseInt(store.getState("chaos.last_id") ?? "0", 10) || 0,
};

// A fresh database (or the first run of this feature) must not swallow the whole donation history at
// once: the meter starts at the newest applied row, so only money given from now on fills it.
if (store.getState("chaos.last_at") === null) {
  chaosCursor = store.lastAppliedCursor();
  store.setState("chaos.last_at", chaosCursor.at);
  store.setState("chaos.last_id", String(chaosCursor.id));
  log("chaos.meter_start", { after: chaosCursor });
}

/**
 * The free rotation cursor: `events.slot` (which code runs next) and `events.next_at` (when).
 *
 * In SQLite for the same reason as the meter: a restart must not reset the three minute clock, and a
 * host that was down for an hour must not fire the whole rotation on boot (`AutoRotation.tick` folds
 * a missed window into one interval).
 */
const storedSlot = Number.parseInt(store.getState("events.slot") ?? "0", 10);
const storedNextAt = Number.parseFloat(store.getState("events.next_at") ?? "");
const autoCursor: AutoCursor = {
  slot: Number.isFinite(storedSlot) && storedSlot > 0 ? storedSlot : 0,
  nextAt:
    Number.isFinite(storedNextAt) && storedNextAt > 0
      ? storedNextAt
      : Date.now() + autoEvents.intervalSec * 1000,
};

const autoRotation = new AutoRotation({
  config: autoEvents,
  // An accessor, not the value: the panel rewrites params at runtime, and the rotation must send the
  // command this catalogue holds at the moment it fires.
  activities: () => catalog,
  cursor: autoCursor,
});

if (store.getState("events.next_at") === null) {
  store.setState("events.slot", String(autoCursor.slot));
  store.setState("events.next_at", String(autoCursor.nextAt));
  log("events.start", {
    slot: autoCursor.slot,
    intervalSec: autoEvents.intervalSec,
    free: autoEvents.free.length,
  });
}

/**
 * Fires the free event of the current slot when `auto-events.json` says it is due.
 *
 * Driven by a one second interval rather than by the donation poll: the countdown on the picture is
 * read every second anyway, and a slot that came due must not wait for the next poll tick. The guard
 * keeps a slow RCON answer from stacking two ticks on one slot.
 */
let autoRunning = false;
async function runAutoEvent(): Promise<void> {
  if (autoRunning) return;
  autoRunning = true;
  try {
    const result = await autoRotation.tick({ lastPaidAt, run: apply });
    if (result.kind === "idle") return;

    const cursor = autoRotation.cursor;
    store.setState("events.slot", String(cursor.slot));
    store.setState("events.next_at", String(cursor.nextAt));

    if (result.kind === "ran") {
      log("events.ran", { code: result.code, command: result.command, reply: result.reply.slice(0, 120) });
    } else if (result.kind === "deferred") {
      log("events.deferred", { code: result.code, paidAgoSec: result.paidAgoSec });
    } else {
      log("events.failed", { code: result.code, command: result.command, error: result.error });
    }
  } finally {
    autoRunning = false;
  }
}

async function collectChaos(): Promise<void> {
  const rows = store.appliedAfter(chaosCursor.at, chaosCursor.id);
  if (rows.length === 0) return;

  let total = chaosTotal;
  let bursts = 0;
  for (const row of rows) {
    const step = addToChaos(total, row.amount, CHAOS_THRESHOLD);
    total = step.total;
    bursts += step.bursts;
  }

  chaosTotal = total;
  const last = rows[rows.length - 1];
  if (last !== undefined) chaosCursor = { at: last.receivedAt, id: last.id };
  store.setState("chaos.total", String(chaosTotal));
  store.setState("chaos.last_at", chaosCursor.at);
  store.setState("chaos.last_id", String(chaosCursor.id));
  if (bursts === 0) return;

  log("chaos.meter_full", { bursts, total: chaosTotal, threshold: CHAOS_THRESHOLD });
  // One burst per full thousand: a 2500 RUB donation buys two effects and leaves 500 on the bar.
  // The effect comes from the chaos list rather than from the plugin's own dice: only what reads as
  // chaos belongs there, and `amx_chaos force` stays the fallback for an empty list.
  for (let index = 0; index < bursts; index += 1) {
    const code = chaosCodeAt(autoEvents, chaosBursts);
    const activity = code === null ? undefined : catalog.activities.find((item) => item.code === code);
    if (activity === undefined && code !== null) {
      log("chaos.missing", { code });
      continue;
    }
    const command = activity === undefined ? "amx_chaos force" : buildActivityCommand(activity);
    try {
      const reply = await apply(command);
      chaosBursts += 1;
      store.setState("chaos.bursts", String(chaosBursts));
      log("chaos.fired", { code: code ?? "plugin", command, reply: reply.slice(0, 120) });
    } catch (error) {
      log("chaos.failed", { code: code ?? "plugin", command, error: (error as Error).message });
    }
  }
}

/**
 * The bed must not outlive the effects.
 *
 * The plugin ends its effects at the round boundary (`OnRoundEnd`), which no clock of ours knows
 * about: the music then keeps playing over a board that has already been cleared - that is the
 * "music stayed after the donation" report. `amx_de status` is the cheapest source of truth (the panel
 * parses the same line), so it is polled here and the bed is cut the moment the game reports nothing.
 */
let lastActiveCode: string | null = null;

async function followGameClock(): Promise<void> {
  let active: string | null;
  try {
    active = parsePluginStatus(await readConsole(STATUS_COMMAND)).active;
  } catch {
    return;
  }

  // Only a real transition counts: an unreachable server (dry run, restart) also answers `none`, and
  // cutting the music for that would silence a donation that is still running.
  if (lastActiveCode !== null && active === null) {
    try {
      writeVoiceRequest(env.overlayDir, { musicStop: true });
      log("voice.bed_cut", { after: lastActiveCode });
    } catch (error) {
      log("voice.failed", { error: (error as Error).message });
    }
  }
  lastActiveCode = active;
}

function currentUiState(): UiState {
  const snapshot = gamePoller.snapshot();
  return buildUiState({
    score: snapshot.score,
    target: snapshot.target,
    winner: snapshot.winner,
    recent: uiRecent,
    catalog,
    pending: uiPending,
    next: autoRotation.next(),
    chaos: { total: chaosTotal, threshold: CHAOS_THRESHOLD },
    stale: snapshot.stale,
  });
}

/**
 * Rewrites the text the encoder draws under the picture when the panel is off: the last donation
 * (nickname and amount) and the countdown to the next free event. Best effort on purpose - a
 * read-only directory must never stop the donation loop.
 *
 * One read of the history serves both consumers: `refreshUiInputs()` fills the panel state and the
 * overlay is built from that snapshot, instead of asking SQLite the same question a second time in
 * the same tick.
 */
function refreshOverlay(): void {
  try {
    refreshUiInputs();
    writeOverlay(
      env.overlayDir,
      buildOverlay({ recent: uiRecent, catalog, next: autoRotation.next(), now: Date.now() }),
    );
  } catch (error) {
    log("overlay.error", { error: (error as Error).message });
  }
}

/**
 * The picture panel: a handful of text files the encoder draws over the game frame with drawtext,
 * rewritten only when the state they show changes. Optional on purpose - without it the stream
 * still runs, with the old drawtext donation line and the plugin's own HUD.
 */
function startUi(): void {
  if (!env.ui.render) {
    log("ui.disabled", { hint: "set UI_RENDER=1 to draw the panel" });
    return;
  }
  try {
    uiLoop = new UiLoop({
      dir: env.overlayDir,
      getState: currentUiState,
      intervalMs: env.ui.intervalMs,
      log,
    });
    gamePoller.start();
    uiLoop.start();
    log("ui.started", { dir: env.overlayDir, intervalMs: env.ui.intervalMs });
  } catch (error) {
    // A missing font or a read-only directory: the stream must survive a broken panel.
    log("ui.error", { error: (error as Error).message });
  }
}

async function checkPluginContract(): Promise<void> {
  if (env.rcon.dryRun) return;
  try {
    const reply = await apply(CODES_PROBE);
    const supported = new Set(parsePluginCodes(reply));
    if (supported.size === 0) {
      // A server without the plugin answers something unrelated; saying "0 missing" would hide that.
      log("plugin.contract_unknown", { reply: reply.slice(0, 120) });
      return;
    }
    const missing = catalog.activities.filter((activity) => !supported.has(activity.code)).map((activity) => activity.code);
    if (missing.length > 0) {
      log("plugin.contract_mismatch", { missing, hint: "activities exist in the catalogue but not in the Pawn plugin" });
    } else {
      // Counted against the catalogue, not against the parsed set: the reply is printed in chunks and
      // the plugin's own log line also carries a `codes:` prefix, so the parse can pick up a word or
      // two that is not a code. The number that matters is how many catalogue entries are supported.
      log("plugin.contract_ok", { activities: catalog.activities.length - missing.length });
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
    rates: env.currencyRates,
    voice,
    silence,
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
  // A live deployment without application credentials cannot poll for donations at all: the only
  // trace is a `poll.error` every few seconds, and that mistake is usually discovered mid-stream.
  // `DA_CLIENT_ID` is the App ID and `DA_CLIENT_SECRET` the API Key of the DonationAlerts
  // application; the tokens come from the one-off `npm run oauth-login`, not from that page.
  if (!env.mock) {
    if (env.da.clientId === "" || env.da.clientSecret === "") {
      throw new Error("DA_MOCK is off but DA_CLIENT_ID (App ID) or DA_CLIENT_SECRET (API Key) is empty in .env");
    }
    if (new TokenStore(DA_TOKEN_PATH).load() === null) {
      throw new Error(`no DonationAlerts tokens in ${DA_TOKEN_PATH}: run \`npm run oauth-login\` once, then start again`);
    }
  }

  const source = env.mock ? mockSource() : liveSource(env.da.clientId, env.da.clientSecret, env.da.redirectUri);
  log("started", {
    mock: env.mock,
    dryRun: env.rcon.dryRun,
    pollSec: env.pollSec,
    activities: catalog.activities.length,
    cursor: store.getLastSeenId(),
  });
  await checkPluginContract();

  // Paid donations that were waiting for their cooldown when the process died are still `queued` in
  // SQLite. They go back into the queue before the first tick, so a restart does not swallow them.
  const restored = restoreQueue({ store, catalog, apply: applyPaid, log, queue, voice });
  if (restored > 0) log("queue.restored", { entries: restored, pending: queue.size });

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // The queue goes first: a viewer who paid a minute ago must not wait behind a fresh poll.
      const drained = await drainQueue({ store, catalog, apply: applyPaid, log, queue, voice });
      if (drained.applied + drained.requeued + drained.failed + drained.expired > 0) {
        log("queue.drained", { ...drained, pending: queue.size });
      }

      const summary = await pollOnce({ store, catalog, fetchDonations: source, apply: applyPaid, log, queue, rates: env.currencyRates, voice });
      if (summary.seen > 0) log("poll.done", { ...summary });
      // The meter is topped up from the rows the poll just wrote, so a burst fires in the same tick
      // that filled it.
      await collectChaos();
    } catch (error) {
      log("poll.error", { error: (error as Error).message });
    } finally {
      // In `finally`: a failed poll must not freeze the overlay on an old donation.
      refreshOverlay();
      running = false;
    }
  };

  await tick();
  // The first free slot: due immediately only when the stored cursor already passed (a restart in
  // the middle of a rotation), otherwise it fires when the countdown on screen reaches zero.
  await runAutoEvent();

  // POLL_ONCE=1 turns the daemon into a single pass: used by smoke runs and by CI.
  if (process.env["POLL_ONCE"] === "1") {
    rcon?.close();
    store.close();
    log("stopped", { once: true });
    process.exit(0);
  }

  // The panel starts after the first poll, so the first frame already carries the donations.
  startUi();
  // The admin panel is started only now, so it opens on real state instead of an empty screen.
  admin = startAdmin();

  const timer = setInterval(() => void tick(), env.pollSec * 1000);
  // Two seconds is enough for a round boundary and costs one RCON line per poll.
  const clock = setInterval(() => void followGameClock(), 2_000);
  // One second: the strip counts down to the second, so the slot has to fire on that second.
  const events = setInterval(() => void runAutoEvent(), 1_000);

  const shutdown = (): void => {
    clearInterval(timer);
    clearInterval(clock);
    clearInterval(events);
    admin?.close();
    gamePoller.stop();
    uiLoop?.stop();
    rcon?.close();
    store.close();
    log("stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
