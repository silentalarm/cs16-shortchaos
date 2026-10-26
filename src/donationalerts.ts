import type { DonationRow } from "./db.ts";

/**
 * DonationAlerts HTTP API (OAuth2 authorization code + donations list).
 *
 * DonationAlerts has no webhooks: real time delivery is Centrifugo over WebSocket, and the
 * plain HTTP way is polling `GET /api/v1/alerts/donations`. We poll, which keeps the whole
 * pipeline idempotent and restart safe (dedup is by donation id).
 */
export const API_BASE = "https://www.donationalerts.com/api/v1";
export const OAUTH_AUTHORIZE = "https://www.donationalerts.com/oauth/authorize";
export const OAUTH_TOKEN = "https://www.donationalerts.com/oauth/token";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token stops working. */
  expiresAt: number;
}

export class DonationAlertsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DonationAlertsError";
  }
}

export function buildAuthorizeUrl(config: OAuthConfig & { scopes: string; state: string }): string {
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", config.state);
  return url.toString();
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DonationAlertsError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseTokens(raw: unknown, now = Date.now()): Tokens {
  const json = asRecord(raw, "token response");
  const accessToken = json.access_token;
  const refreshToken = json.refresh_token;
  const expiresIn = json.expires_in;

  if (typeof accessToken !== "string" || accessToken === "") {
    throw new DonationAlertsError("token response has no access_token");
  }
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new DonationAlertsError("token response has no refresh_token");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new DonationAlertsError("token response has no expires_in");
  }

  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000 };
}

async function postForm(url: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new DonationAlertsError(`POST ${url} failed with ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DonationAlertsError(`POST ${url} returned non JSON`);
  }
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<Tokens> {
  const json = await postForm(
    OAUTH_TOKEN,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    },
    fetchImpl,
  );
  return parseTokens(json, now);
}

export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<Tokens> {
  const json = await postForm(
    OAUTH_TOKEN,
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
  return parseTokens(json, now);
}

/** Normalizes the donations list; `amount` arrives as a number or a numeric string. */
export function parseDonations(raw: unknown): DonationRow[] {
  const json = asRecord(raw, "donations response");
  const data = json.data;
  if (!Array.isArray(data)) throw new DonationAlertsError("donations response has no data array");

  const rows: DonationRow[] = [];
  for (const item of data) {
    const entry = asRecord(item, "donation");
    const id = typeof entry.id === "string" ? Number(entry.id) : entry.id;
    const amount = typeof entry.amount === "string" ? Number(entry.amount) : entry.amount;
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    if (typeof entry.currency !== "string") continue;

    rows.push({
      id,
      username: typeof entry.username === "string" ? entry.username : "anon",
      amount,
      currency: entry.currency,
      message: typeof entry.message === "string" ? entry.message : null,
      createdAt: typeof entry.created_at === "string" ? entry.created_at : null,
    });
  }
  return rows;
}

export async function fetchDonations(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DonationRow[]> {
  const response = await fetchImpl(`${API_BASE}/alerts/donations?page=1`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new DonationAlertsError(`GET donations failed with ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return parseDonations(JSON.parse(text));
  } catch (error) {
    if (error instanceof DonationAlertsError) throw error;
    throw new DonationAlertsError("GET donations returned non JSON");
  }
}
