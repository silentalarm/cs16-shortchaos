import { existsSync } from "node:fs";
import { parseCurrencyRates } from "./mapping.ts";

/**
 * Environment is read once and validated at startup: a misconfigured control API should
 * fail loudly while nobody is watching the stream, not in the middle of a donation.
 */
export interface Env {
  activitiesPath: string;
  dbPath: string;
  /** Where the overlay text for the encoder is written; the capture container mounts it read-only. */
  overlayDir: string;
  mock: boolean;
  mockFile: string;
  pollSec: number;
  /**
   * RUB per unit of a foreign currency, merged over `DEFAULT_CURRENCY_RATES`. Read from
   * `CURRENCY_RATES` (JSON) so a moved exchange rate is a restart, not a code change.
   */
  currencyRates: Record<string, number>;
  da: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
  };
  rcon: {
    host: string;
    port: number;
    password: string;
    timeoutMs: number;
    /** true when no rcon_password is configured: commands are logged, not sent. */
    dryRun: boolean;
  };
  admin: {
    /** Interface the panel binds to. 127.0.0.1 on purpose: RCON rights do not belong on a LAN. */
    bind: string;
    port: number;
    /** Shared secret for /api; when empty the panel is not started at all. */
    token: string;
    /** Debug donations from the panel; off in production so the panel cannot fake revenue. */
    simAllowed: boolean;
    publicDir: string;
    /** Runtime tweaks from the panel, kept out of the versioned catalogue. */
    overridePath: string;
    /** Directory the capture container writes status.json/progress.txt into (read-only here). */
    streamStatusDir: string;
    /** MediaMTX HLS endpoint the embedded player uses (built into the page on the client side). */
    hlsPort: number;
    hlsPath: string;
  };
  ui: {
    /** false disables the panel entirely: the encoder then keeps the old drawtext layer. */
    render: boolean;
    /** How often the state is compared against the files last written for the encoder. */
    intervalMs: number;
  };
}

function text(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function integer(name: string, fallback: number, min: number): number {
  const raw = text(name);
  if (raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return parsed;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = text(name);
  if (raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Loads `.env` when present, then reads and validates the process environment. */
export function loadEnv(envFile = ".env"): Env {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  const password = text("RCON_PASSWORD");

  return {
    activitiesPath: text("ACTIVITIES_PATH", "config/activities.json"),
    dbPath: text("DB_PATH", "data/control.db"),
    overlayDir: text("OVERLAY_DIR", "data/overlay"),
    mock: flag("DA_MOCK", false),
    mockFile: text("DA_MOCK_FILE", "data/mock-donations.json"),
    // 3 s, not 10: a viewer who paid and sees nothing for ten seconds has already swiped to the
    // next Short. The API is polled with pagination, so a burst still arrives in one go.
    pollSec: integer("DA_POLL_SEC", 3, 3),
    // Throws at startup on a malformed table: a broken rate silently halves donations.
    currencyRates: parseCurrencyRates(process.env["CURRENCY_RATES"]),
    da: {
      clientId: text("DA_CLIENT_ID"),
      clientSecret: text("DA_CLIENT_SECRET"),
      redirectUri: text("DA_REDIRECT_URI", "http://127.0.0.1:4318/oauth/callback"),
      scopes: text("DA_SCOPE", "oauth-user-show oauth-donation-index"),
    },
    rcon: {
      host: text("RCON_HOST", "127.0.0.1"),
      port: integer("RCON_PORT", 27015, 1),
      password,
      timeoutMs: integer("RCON_TIMEOUT_MS", 5000, 100),
      dryRun: password === "",
    },
    admin: {
      bind: text("ADMIN_BIND", "127.0.0.1"),
      port: integer("ADMIN_PORT", 8080, 1),
      token: text("ADMIN_TOKEN"),
      simAllowed: flag("ADMIN_SIM_ALLOWED", true),
      publicDir: text("ADMIN_PUBLIC_DIR", "public"),
      overridePath: text("ACTIVITIES_OVERRIDE_PATH", "data/activities.override.json"),
      streamStatusDir: text("STREAM_STATUS_DIR", "data/stream"),
      hlsPort: integer("STREAM_HLS_PORT", 8888, 1),
      hlsPath: text("STREAM_HLS_PATH", "live/test").replace(/^\/+|\/+$/g, ""),
    },
    ui: {
      render: flag("UI_RENDER", true),
      intervalMs: integer("UI_INTERVAL_MS", 200, 50),
    },
  };
}
