import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { loadActivities } from "../src/activities.ts";
import type { ActivitiesConfig } from "../src/activities.ts";
import { OverrideStore, parseOverrides } from "../src/activities-override.ts";
import { createAdminServer } from "../src/admin/server.ts";
import { Store } from "../src/db.ts";

/**
 * The panel is the only way a human can send RCON commands directly, so the HTTP surface is tested
 * for the boring properties: token required, JSON required, unknown fields refused, and every
 * command it builds goes through the same builder the donation pipeline uses.
 */
const TOKEN = "test-token-123";
const BASE = loadActivities(new URL("../config/activities.json", import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

interface Context {
  url: string;
  commands: string[];
  getCatalog: () => ActivitiesConfig;
  path: string;
}

interface ServerOptions {
  simAllowed?: boolean;
  /** Test knob for the trigger/simulate limiter; production uses the defaults in server.ts. */
  rateLimit?: { capacity?: number; refillMs?: number };
  /** Controllable clock for the bucket: the tests must not sleep for a real minute. */
  now?: () => number;
}

async function withServer(run: (context: Context) => Promise<void>, options: ServerOptions = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cs16-admin-"));
  const overridePath = join(dir, "activities.override.json");
  const store = new Store(":memory:");
  const commands: string[] = [];
  let catalog: ActivitiesConfig = BASE;

  const server = createAdminServer({
    token: TOKEN,
    publicDir: PUBLIC_DIR,
    store,
    getCatalog: () => catalog,
    getBaseCatalog: () => BASE,
    setCatalog: (next) => { catalog = next; },
    overrides: new OverrideStore(overridePath),
    apply: async (command: string) => {
      commands.push(command);
      return "L 01/01/2026 - 12:00:00: ok";
    },
    streamStatusDir: join(dir, "stream"),
    playback: { port: 8888, path: "live/test" },
    mode: { mock: true, dryRun: false, simAllowed: options.simAllowed ?? true },
    log: () => {},
    now: options.now,
    rateLimit: options.rateLimit,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run({ url: `http://127.0.0.1:${port}`, commands, getCatalog: () => catalog, path: overridePath });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function api(url: string, path: string, init: RequestInit = {}, token = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "x-admin-token": token };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
}

test("the panel page is served, and the API refuses a request without the token", async () => {
  await withServer(async ({ url }) => {
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /donation panel/);

    const without = await fetch(`${url}/api/state`);
    assert.equal(without.status, 401);

    const wrong = await api(url, "/api/state", {}, "not-the-token");
    assert.equal(wrong.status, 401);
  });
});

test("the token is only accepted from the X-Admin-Token header", async () => {
  await withServer(async ({ url }) => {
    // A query-string token ends up in browser history and in every proxy log: it is not a way in.
    const viaQuery = await fetch(`${url}/api/state?token=${encodeURIComponent(TOKEN)}`);
    assert.equal(viaQuery.status, 401);

    const viaHeader = await api(url, "/api/state");
    assert.equal(viaHeader.status, 200);
  });
});

test("trigger and simulate answer 429 once the bucket is empty, and recover after the refill", async () => {
  let clock = Date.parse("2026-01-01T12:00:00.000Z");
  await withServer(async ({ url, commands }) => {
    const trigger = (): Promise<Response> =>
      api(url, "/api/trigger", { method: "POST", body: JSON.stringify({ code: "awp_only" }) });

    assert.equal((await trigger()).status, 200);
    assert.equal((await trigger()).status, 200);

    const limited = await trigger();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1, "the answer says when to come back");
    assert.equal(commands.filter((command) => command === "amx_de awp_only").length, 2, "a limited request never reached RCON");

    // One token per second in this configuration: after the wait the panel works again.
    clock += 1000;
    assert.equal((await trigger()).status, 200);

    // The read path is not throttled: the page polls the state every two seconds.
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await api(url, "/api/state")).status, 200);
    }
  }, { rateLimit: { capacity: 2, refillMs: 1000 }, now: () => clock });
});

test("state lists the catalogue, the overrides and the stream telemetry slot", async () => {
  await withServer(async ({ url }) => {
    const response = await api(url, "/api/state");
    assert.equal(response.status, 200);

    const state = (await response.json()) as {
      activities: { code: string }[];
      overridden: string[];
      mode: { mock: boolean; simAllowed: boolean; minAmount: number };
      stream: { configured: boolean };
      statusError: string | null;
    };

    assert.equal(state.activities.length, BASE.activities.length);
    assert.deepEqual(state.overridden, []);
    assert.equal(state.mode.mock, true);
    assert.equal(state.mode.simAllowed, true);
    assert.equal(state.mode.minAmount, BASE.minAmount);
    assert.equal(state.stream.configured, false);
    assert.equal(state.statusError, null);
  });
});

test("a simulated donation returns the verdict and the exact RCON command", async () => {
  await withServer(async ({ url, commands }) => {
    const response = await api(url, "/api/simulate", { method: "POST", body: JSON.stringify({ amount: 60, username: "Вася" }) });
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      outcome: { status: string; activityCode: string; command: string };
      activity: { code: string } | null;
    };

    assert.equal(body.outcome.status, "applied");
    assert.match(body.outcome.activityCode, /^(crowd_pile|sniper_moment|glass_cannon|ice_floor|meteor_shower|red_light|lightsaber_duel|one_bullet)$/);
    assert.match(body.outcome.command, /^amx_de [a-z_]+ (.* )?nick=vasya$/);
    // body.activity echoes the catalogue entry the panel matched; the code itself is drawn at random.
    assert.ok(commands.includes(body.outcome.command), "the exact command is in the log");
  });
});

test("a simulated foreign donation is converted with the same table the poller uses", async () => {
  await withServer(async ({ url }) => {
    // 2 USD = 180 RUB = three 50 RUB steps of the only effect on sale.
    const response = await api(url, "/api/simulate", {
      method: "POST",
      body: JSON.stringify({ amount: 2, currency: "usd", username: "Almaty" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { outcome: { status: string; activityCode: string; command: string } };
    assert.equal(body.outcome.status, "applied");
    const onSale = ["crowd_pile", "sniper_moment", "glass_cannon", "ice_floor", "meteor_shower", "red_light", "lightsaber_duel", "one_bullet"];
    for (const code of body.outcome.activityCode.split("+")) assert.ok(onSale.includes(code), `${code} is not on sale`);
    assert.match(body.outcome.command, /nick=almaty/);
  assert.match(body.outcome.command, /seconds=(15|30|45)/, "150 RUB is three 15 second steps");
  });
});

test("a donation below the minimum is explained instead of being swallowed", async () => {
  await withServer(async ({ url }) => {
    const response = await api(url, "/api/simulate", { method: "POST", body: JSON.stringify({ amount: 10 }) });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { outcome: { status: string; reason: string } };
    assert.equal(body.outcome.status, "rejected");
    assert.equal(body.outcome.reason, "below_minimum");
  });
});

test("simulation can be switched off, and a bad body is rejected with 400", async () => {
  await withServer(async ({ url }) => {
    const denied = await api(url, "/api/simulate", { method: "POST", body: JSON.stringify({ amount: 60 }) });
    assert.equal(denied.status, 403);
  }, { simAllowed: false });

  await withServer(async ({ url }) => {
    const negative = await api(url, "/api/simulate", { method: "POST", body: JSON.stringify({ amount: -5 }) });
    assert.equal(negative.status, 400);

    const notJson = await fetch(`${url}/api/simulate`, {
      method: "POST",
      headers: { "x-admin-token": TOKEN, "content-type": "text/plain" },
      body: "amount=60",
    });
    assert.equal(notJson.status, 415);
  });
});

test("editing a price is validated, persisted and applied to the running catalogue", async () => {
  await withServer(async ({ url, getCatalog, path }) => {
    const response = await api(url, "/api/activity/knives_only", { method: "POST", body: JSON.stringify({ price: 80 }) });
    assert.equal(response.status, 200);
    assert.equal(getCatalog().activities.find((activity) => activity.code === "knives_only")?.price, 80);

    const saved = parseOverrides(JSON.parse(readFileSync(path, "utf8")) as unknown);
    assert.equal(saved.activities["knives_only"]?.price, 80);

    const invalid = await api(url, "/api/activity/knives_only", { method: "POST", body: JSON.stringify({ price: 10 }) });
    assert.equal(invalid.status, 400);
    assert.equal(getCatalog().activities.find((activity) => activity.code === "knives_only")?.price, 80);

    const typo = await api(url, "/api/activity/knives_only", { method: "POST", body: JSON.stringify({ prise: 90 }) });
    assert.equal(typo.status, 400);

    const reset = await api(url, "/api/activity/knives_only/reset", { method: "POST", body: JSON.stringify({}) });
    assert.equal(reset.status, 200);
    assert.equal(getCatalog().activities.find((activity) => activity.code === "knives_only")?.price, 75);
  });
});

test("trigger, clear and sim-reset build the commands the plugin expects", async () => {
  await withServer(async ({ url, commands }) => {
    const trigger = await api(url, "/api/trigger", { method: "POST", body: JSON.stringify({ code: "awp_only" }) });
    assert.equal(trigger.status, 200);
    assert.ok(commands.includes("amx_de awp_only"));

    const unknown = await api(url, "/api/trigger", { method: "POST", body: JSON.stringify({ code: "nope" }) });
    assert.equal(unknown.status, 404);

    const simulate = await api(url, "/api/simulate", { method: "POST", body: JSON.stringify({ amount: 60, username: "Debug" }) });
    assert.equal(simulate.status, 200);

    const cleared = await api(url, "/api/clear", { method: "POST", body: JSON.stringify({}) });
    assert.equal(cleared.status, 200);
    assert.ok(commands.includes("amx_de clear"));

    const reset = await api(url, "/api/sim-reset", { method: "POST", body: JSON.stringify({}) });
    assert.equal(reset.status, 200);
    assert.equal(((await reset.json()) as { deleted: number }).deleted, 1);

    // Every panel command is kept as an audit trail, with the exact RCON line and the reply.
    const state = (await (await api(url, "/api/state")).json()) as { adminActions: { kind: string; command: string | null }[] };
    const kinds = state.adminActions.map((action) => action.kind);
    assert.ok(kinds.includes("trigger"));
    assert.ok(kinds.includes("clear"));
    assert.ok(kinds.includes("sim_reset"));
    assert.ok(state.adminActions.some((action) => action.command === "amx_de awp_only"));
  });
});

test("running an activity with parameters sends them and refuses values that would break RCON", async () => {
  await withServer(async ({ url, commands }) => {
    const withParams = await api(url, "/api/trigger", {
      method: "POST",
      body: JSON.stringify({ code: "bot_rain", params: { extraBots: 10 } }),
    });
    assert.equal(withParams.status, 200);
    const body = (await withParams.json()) as { command: string };
    assert.equal(body.command, "amx_de bot_rain extraBots=10 maxBots=22 seconds=90");
    assert.ok(commands.includes("amx_de bot_rain extraBots=10 maxBots=22 seconds=90"));

    const injected = await api(url, "/api/trigger", {
      method: "POST",
      body: JSON.stringify({ code: "bot_rain", params: { extraBots: "10; rcon_password x" } }),
    });
    assert.equal(injected.status, 400);
    assert.equal(commands.filter((command) => command.includes("rcon_password")).length, 0);
  });
});

test("settings are saved as an override, and an impossible minimum is refused", async () => {
  await withServer(async ({ url, getCatalog }) => {
    const cooldown = await api(url, "/api/settings", { method: "POST", body: JSON.stringify({ defaultCooldownSec: 120 }) });
    assert.equal(cooldown.status, 200);
    assert.equal(getCatalog().defaultCooldownSec, 120);

    // The cheapest activity costs 50 RUB: a higher minimum would make it unreachable, and the
    // catalogue parser refuses that combination instead of letting the panel create it.
    const tooHigh = await api(url, "/api/settings", { method: "POST", body: JSON.stringify({ minAmount: 60 }) });
    assert.equal(tooHigh.status, 400);
    assert.match(((await tooHigh.json()) as { error: string }).error, /minAmount/);
    assert.equal(getCatalog().minAmount, 50);
  });
});
