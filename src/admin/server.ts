import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { ActivitiesConfig, Activity } from "../activities.ts";
import { applyOverrides, OverrideError, parseOverrides } from "../activities-override.ts";
import type { ActivityPatch, OverrideDocument, OverrideStore } from "../activities-override.ts";
import { buildActivityCommand } from "../command.ts";
import type { Store } from "../db.ts";
import { processDonation } from "../poller.ts";
import { buildState } from "./state.ts";

/**
 * Admin HTTP server.
 *
 * Why node:http and not a framework: the panel is one HTML file with a bit of fetch, and every
 * dependency in the control API is a dependency that must be audited on a machine that talks to
 * the game server with RCON rights. Nothing here is reachable from the internet either: the server
 * binds 127.0.0.1 and every /api call needs the token from .env.
 */

const MAX_BODY_BYTES = 64 * 1024;
const CLEAR_COMMAND = "amx_de clear";

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "admin.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "admin.html", type: "text/html; charset=utf-8" },
  "/admin.js": { file: "admin.js", type: "text/javascript; charset=utf-8" },
  // Vendored hls.js: the player must not depend on a CDN, and the browser has to trust the script.
  "/hls.min.js": { file: "hls.min.js", type: "text/javascript; charset=utf-8" },
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string, type: string): void {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "send application/json");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body is too large");
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/**
 * Compares two secrets without leaking their length: hashing first makes both sides the same
 * fixed size, so timingSafeEqual is allowed to run and the response time says nothing.
 */
function sameToken(expected: string, received: string): boolean {
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(received).digest();
  return timingSafeEqual(left, right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Token bucket for the two endpoints that reach the game server.
 *
 * Why a bucket and not "one request per second": the panel legitimately sends a trigger and then a
 * simulation while the owner works, and a hard 1 s gap would answer 429 to their own clicks. A
 * bucket absorbs that burst (10 tokens) and still caps the sustained rate at 10 per minute, which is
 * the limit that matters for an endpoint that renames bots and starts map changes.
 */
export interface RateLimitOptions {
  /** How many requests may arrive back to back. */
  capacity?: number;
  /** How long one spent token takes to come back; 6000 ms = 10 per minute at full burst. */
  refillMs?: number;
}

const DEFAULT_RATE_LIMIT: Required<RateLimitOptions> = { capacity: 10, refillMs: 6000 };
/** Only the routes that send RCON commands are limited: reads must never be throttled. */
const RATE_LIMITED_PATHS = new Set(["/api/trigger", "/api/simulate"]);

export class TokenBucket {
  readonly #capacity: number;
  readonly #refillMs: number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  // Two fields instead of parameter properties: native TS stripping has no compiler to expand them.
  constructor(options: RateLimitOptions = {}) {
    this.#capacity = Math.max(1, options.capacity ?? DEFAULT_RATE_LIMIT.capacity);
    this.#refillMs = Math.max(1, options.refillMs ?? DEFAULT_RATE_LIMIT.refillMs);
  }

  /** 0 when the request is allowed, otherwise the whole seconds to wait before retrying. */
  take(key: string, now: number): number {
    const previous = this.#buckets.get(key);
    const elapsed = previous === undefined ? 0 : Math.max(0, now - previous.updatedAt);
    const tokens = Math.min(this.#capacity, (previous?.tokens ?? this.#capacity) + elapsed / this.#refillMs);

    if (tokens < 1) {
      this.#buckets.set(key, { tokens, updatedAt: now });
      return Math.max(1, Math.ceil(((1 - tokens) * this.#refillMs) / 1000));
    }

    this.#buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return 0;
  }
}

export interface AdminDeps {
  /** Shared secret from .env; every /api call must present it in X-Admin-Token. */
  token: string;
  publicDir: string;
  store: Store;
  /** Catalogue with runtime overrides applied: what the poller maps against right now. */
  getCatalog: () => ActivitiesConfig;
  /** Catalogue exactly as shipped in config/activities.json, the base for every override. */
  getBaseCatalog: () => ActivitiesConfig;
  setCatalog: (next: ActivitiesConfig) => void;
  overrides: OverrideStore;
  apply: (command: string) => Promise<string>;
  streamStatusDir: string;
  /** HLS endpoint the page embeds; the browser fills in the host. */
  playback: { port: number; path: string };
  mode: { mock: boolean; dryRun: boolean; simAllowed: boolean };
  log: (event: string, details?: Record<string, unknown>) => void;
  now?: () => number;
  /** Burst and refill of the trigger/simulate limiter; the defaults are the production values. */
  rateLimit?: RateLimitOptions;
  /** Currency table for simulated foreign donations; the poller uses the same one. */
  rates?: Record<string, number>;
  /** Announcement voice (`src/voice.ts`): called once per donation with everything it bought. */
  voice?: (activities: readonly Activity[]) => void;
  /** Silence the bed and any cue; the Stop button must not leave music playing over a cleared board. */
  silence?: () => void;
}

async function serveStatic(deps: AdminDeps, path: string, response: ServerResponse): Promise<void> {
  const entry = STATIC_FILES[path];
  if (entry === undefined) throw new HttpError(404, "not found");
  let body: string;
  try {
    body = await readFile(join(deps.publicDir, entry.file), "utf8");
  } catch {
    throw new HttpError(500, `cannot read ${entry.file} from ${deps.publicDir}`);
  }
  // The panel is local and changes with every deploy: caching it only produces stale screens.
  sendText(response, 200, body, entry.type);
}

/**
 * Simulated donation ids are negative, so they can never collide with a DonationAlerts id and the
 * poll cursor (which only moves forward over positive ids) is not affected even by accident.
 */
function nextSimId(deps: AdminDeps): number {
  let id = -(deps.now?.() ?? Date.now());
  while (deps.store.has(id)) id -= 1;
  return id;
}

async function handleSimulate(deps: AdminDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!deps.mode.simAllowed) throw new HttpError(403, "simulation is disabled by ADMIN_SIM_ALLOWED=0");

  const body = await readJson(request);
  if (!isObject(body)) throw new HttpError(400, "body must be an object");

  const amount = Number(body["amount"]);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "amount must be a positive number");

  const rawName = body["username"];
  const username = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim().slice(0, 64) : "TestDonor";
  const rawCurrency = body["currency"];
  const currency = typeof rawCurrency === "string" && rawCurrency.trim() !== "" ? rawCurrency.trim().toUpperCase() : deps.getCatalog().currency;
  const rawMessage = body["message"];
  const message = typeof rawMessage === "string" ? rawMessage.slice(0, 200) : null;

  // The simulator goes through the same path as a real donation: one call, the whole batch.
  const voiceForSim = deps.voice;

  const outcome = await processDonation(
    { store: deps.store, catalog: deps.getCatalog(), apply: deps.apply, log: deps.log, now: deps.now, rates: deps.rates, voice: voiceForSim },
    { id: nextSimId(deps), username, amount, currency, message, createdAt: new Date(deps.now?.() ?? Date.now()).toISOString() },
    { advanceCursor: false, bypassCooldown: body["bypassCooldown"] === true, source: "sim" },
  );

  deps.log("admin.simulated", { amount, username, status: outcome.status, activity: outcome.activityCode });
  const firstCode = typeof outcome.activityCode === "string" ? outcome.activityCode.split("+")[0] ?? null : null;
  const activity = firstCode === null
    ? null
    : deps.getCatalog().activities.find((item) => item.code === firstCode) ?? null;

  sendJson(response, 200, {
    outcome,
    activity: activity === null ? null : { code: activity.code, title: activity.title, price: activity.price },
  });
}

function requireInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/**
 * Validates, persists and activates an override document. Validation happens before the write, so
 * a rejected edit leaves the running catalogue untouched.
 */
function saveOverrides(deps: AdminDeps, document: OverrideDocument): ActivitiesConfig {
  let next: ActivitiesConfig;
  try {
    next = applyOverrides(deps.getBaseCatalog(), document);
  } catch (error) {
    if (error instanceof OverrideError) throw new HttpError(400, error.message);
    throw error;
  }
  deps.overrides.write(document);
  deps.setCatalog(next);
  deps.log("admin.overrides_saved", { activities: Object.keys(document.activities).sort(), minAmount: next.minAmount });
  return next;
}

const PATCH_FIELDS = new Set(["price", "cooldownSec", "globalCooldownSec", "enabled", "params"]);

async function handleActivityPatch(deps: AdminDeps, code: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (!isObject(body)) throw new HttpError(400, "body must be an object");

  const unknownFields = Object.keys(body).filter((key) => !PATCH_FIELDS.has(key));
  if (unknownFields.length > 0) throw new HttpError(400, `unknown fields: ${unknownFields.join(", ")}`);

  const base = deps.getBaseCatalog();
  const original = base.activities.find((item) => item.code === code);
  if (original === undefined) throw new HttpError(404, `no activity "${code}"`);

  const document = parseOverrides(deps.overrides.read());
  const patch: ActivityPatch = { ...(document.activities[code] ?? {}) };

  if (body["price"] !== undefined) patch.price = requireInt(body["price"], "price", 0, 1_000_000);
  if (body["cooldownSec"] !== undefined) patch.cooldownSec = requireInt(body["cooldownSec"], "cooldownSec", 0, 86_400);
  if (body["globalCooldownSec"] !== undefined) patch.globalCooldownSec = requireInt(body["globalCooldownSec"], "globalCooldownSec", 0, 86_400);
  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    patch.enabled = body["enabled"];
  }
  if (body["params"] !== undefined) {
    if (!isObject(body["params"])) throw new HttpError(400, "params must be an object");
    patch.params = body["params"] as NonNullable<ActivityPatch["params"]>;
  }

  document.activities[code] = patch;
  const next = saveOverrides(deps, document);
  deps.store.recordAdminAction({
    at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    kind: "override",
    code,
    params: patch as unknown as Record<string, unknown>,
    reply: `catalogue accepted the change`,
  });
  sendJson(response, 200, {
    activity: next.activities.find((item) => item.code === code) ?? null,
    overridden: Object.keys(document.activities).sort(),
  });
}

async function handleActivityReset(deps: AdminDeps, code: string, response: ServerResponse): Promise<void> {
  const document = parseOverrides(deps.overrides.read());
  if (document.activities[code] === undefined) {
    throw new HttpError(404, `activity "${code}" has no override`);
  }
  delete document.activities[code];
  const next = saveOverrides(deps, document);
  deps.store.recordAdminAction({
    at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    kind: "override_reset",
    code,
    reply: "override dropped",
  });
  sendJson(response, 200, {
    activity: next.activities.find((item) => item.code === code) ?? null,
    overridden: Object.keys(document.activities).sort(),
  });
}

async function handleSettings(deps: AdminDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (!isObject(body)) throw new HttpError(400, "body must be an object");

  const document = parseOverrides(deps.overrides.read());
  if (body["minAmount"] !== undefined) document.minAmount = requireInt(body["minAmount"], "minAmount", 1, 1_000_000);
  if (body["defaultCooldownSec"] !== undefined) {
    document.defaultCooldownSec = requireInt(body["defaultCooldownSec"], "defaultCooldownSec", 0, 86_400);
  }

  const next = saveOverrides(deps, document);
  deps.store.recordAdminAction({
    at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    kind: "settings",
    params: { minAmount: next.minAmount, defaultCooldownSec: next.defaultCooldownSec },
    reply: "catalogue accepted the change",
  });
  sendJson(response, 200, { minAmount: next.minAmount, defaultCooldownSec: next.defaultCooldownSec });
}

async function handleTrigger(deps: AdminDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (!isObject(body)) throw new HttpError(400, "body must be an object");

  const code = body["code"];
  if (typeof code !== "string" || code === "") throw new HttpError(400, "code is required");

  const found = deps.getCatalog().activities.find((item) => item.code === code);
  if (found === undefined) throw new HttpError(404, `no activity "${code}"`);

  // Parameters from the panel are a patch over the catalogue: they go through the same builder as a
  // donation, so a value that would break the RCON line is refused here, not in the game.
  const rawParams = body["params"];
  let activity = found;
  if (rawParams !== undefined) {
    if (!isObject(rawParams)) throw new HttpError(400, "params must be an object");
    activity = { ...found, params: { ...found.params, ...(rawParams as NonNullable<ActivityPatch["params"]>) } };
  }

  const rawNick = body["nick"];
  const nick = typeof rawNick === "string" && rawNick.trim() !== "" ? rawNick.trim() : undefined;

  let command: string;
  try {
    command = buildActivityCommand(activity, nick === undefined ? {} : { nick });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }

  const reply = await deps.apply(command);
  deps.store.recordAdminAction({
    at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    kind: "trigger",
    code,
    params: rawParams === undefined ? undefined : (rawParams as Record<string, unknown>),
    command,
    reply,
  });
  deps.log("admin.triggered", { code, command, reply });
  // The panel run is a rehearsal of the paid flow, audio included: without this the operator would
  // test a silent event and never hear the bed or the announcement before a donation pays for them.
  try {
    deps.voice?.([activity]);
  } catch (error) {
    deps.log("voice.failed", { activity: activity.code, error: (error as Error).message });
  }
  sendJson(response, 200, { command, reply });
}

const ACTIVITY_PATH = /^\/api\/activity\/([a-z0-9_]{1,32})$/;
const ACTIVITY_RESET_PATH = /^\/api\/activity\/([a-z0-9_]{1,32})\/reset$/;

async function route(
  deps: AdminDeps,
  limiter: TokenBucket,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (request.method === "GET" && STATIC_FILES[path] !== undefined) {
    await serveStatic(deps, path, response);
    return;
  }
  if (!path.startsWith("/api/")) throw new HttpError(404, "not found");

  // The token travels in a header only. A `?token=` was dropped on purpose: query strings end up in
  // browser history, in proxy access logs and in the Referer of every link on the page, and the
  // panel never needed it. It is never echoed back either.
  const header = request.headers["x-admin-token"];
  const received = typeof header === "string" ? header : "";
  if (!sameToken(deps.token, received)) throw new HttpError(401, "missing or invalid X-Admin-Token");

  if (request.method === "POST" && RATE_LIMITED_PATHS.has(path)) {
    const waitSec = limiter.take(path, deps.now?.() ?? Date.now());
    if (waitSec > 0) {
      response.setHeader("retry-after", String(waitSec));
      deps.log("admin.rate_limited", { path, retryAfterSec: waitSec });
      throw new HttpError(429, `too many requests on ${path}, retry in ${waitSec}s`);
    }
  }

  if (request.method === "GET" && path === "/api/state") {
    const state = await buildState({
      store: deps.store,
      getCatalog: deps.getCatalog,
      getOverrides: () => parseOverrides(deps.overrides.read()),
      apply: deps.apply,
      streamStatusDir: deps.streamStatusDir,
      playback: deps.playback,
      mode: deps.mode,
      now: deps.now,
    });
    sendJson(response, 200, state);
    return;
  }

  if (request.method !== "POST") throw new HttpError(405, "method not allowed");

  if (path === "/api/simulate") { await handleSimulate(deps, request, response); return; }
  if (path === "/api/trigger") { await handleTrigger(deps, request, response); return; }
  if (path === "/api/settings") { await handleSettings(deps, request, response); return; }

  if (path === "/api/clear") {
    const reply = await deps.apply(CLEAR_COMMAND);
    // The game stopped the effect, so the music has to stop with it: a bed playing over a cleared
    // board would look like the event is still running.
    try {
      deps.silence?.();
    } catch (error) {
      deps.log("admin.silence_failed", { error: (error as Error).message });
    }
    deps.store.recordAdminAction({
      at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      kind: "clear",
      command: CLEAR_COMMAND,
      reply,
    });
    deps.log("admin.cleared", { reply });
    sendJson(response, 200, { command: CLEAR_COMMAND, reply });
    return;
  }

  if (path === "/api/sim-reset") {
    const deleted = deps.store.resetSim();
    deps.store.recordAdminAction({
      at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      kind: "sim_reset",
      reply: `deleted ${deleted} rows`,
    });
    deps.log("admin.sim_reset", { deleted });
    sendJson(response, 200, { deleted });
    return;
  }

  const resetMatch = ACTIVITY_RESET_PATH.exec(path);
  if (resetMatch !== null) { await handleActivityReset(deps, resetMatch[1] ?? "", response); return; }

  const patchMatch = ACTIVITY_PATH.exec(path);
  if (patchMatch !== null) { await handleActivityPatch(deps, patchMatch[1] ?? "", request, response); return; }

  throw new HttpError(404, "not found");
}

export function createAdminServer(deps: AdminDeps): Server {
  const limiter = new TokenBucket(deps.rateLimit);
  return createServer((request, response) => {
    route(deps, limiter, request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) deps.log("admin.error", { message });
      if (!response.headersSent) {
        sendJson(response, status, { error: message });
      } else {
        response.end();
      }
    });
  });
}
