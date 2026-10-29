import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DonationAlertsError,
  MAX_PAGES,
  buildAuthorizeUrl,
  exchangeCode,
  fetchDonations,
  parseDonations,
  parseTokens,
  refreshTokens,
} from "../src/donationalerts.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const oauth = { clientId: "id", clientSecret: "secret", redirectUri: "http://127.0.0.1:4318/oauth/callback" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("authorize url carries the documented scopes", () => {
  const url = new URL(
    buildAuthorizeUrl({ ...oauth, scopes: "oauth-user-show oauth-donation-index", state: "abc123" }),
  );
  assert.equal(url.origin + url.pathname, "https://www.donationalerts.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "id");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "oauth-user-show oauth-donation-index");
  assert.equal(url.searchParams.get("state"), "abc123");
  assert.equal(url.searchParams.get("redirect_uri"), oauth.redirectUri);
});

test("token response is turned into an absolute expiry", () => {
  const tokens = parseTokens({ access_token: "a", refresh_token: "r", expires_in: 3600 }, NOW);
  assert.deepEqual(tokens, { accessToken: "a", refreshToken: "r", expiresAt: NOW + 3_600_000 });
});

test("incomplete token responses are refused", () => {
  assert.throws(() => parseTokens({ refresh_token: "r", expires_in: 1 }, NOW), /no access_token/);
  assert.throws(() => parseTokens({ access_token: "a", expires_in: 1 }, NOW), /no refresh_token/);
  assert.throws(() => parseTokens({ access_token: "a", refresh_token: "r" }, NOW), /no expires_in/);
  assert.throws(() => parseTokens([], NOW), /must be a JSON object/);
});

test("code exchange posts the authorization_code grant", async () => {
  const captured = { url: "", body: "" };
  const fakeFetch: typeof fetch = async (input, init) => {
    captured.url = String(input);
    captured.body = String(init?.body);
    return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 60 });
  };

  const tokens = await exchangeCode(oauth, "the-code", fakeFetch, NOW);
  assert.equal(tokens.accessToken, "a");
  assert.equal(captured.url, "https://www.donationalerts.com/oauth/token");
  const form = new URLSearchParams(captured.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "the-code");
  assert.equal(form.get("redirect_uri"), oauth.redirectUri);
});

test("refresh uses the refresh_token grant", async () => {
  let body = "";
  const fakeFetch: typeof fetch = async (_input, init) => {
    body = String(init?.body);
    return jsonResponse({ access_token: "a2", refresh_token: "r2", expires_in: 60 });
  };

  const tokens = await refreshTokens(oauth, "old-refresh", fakeFetch, NOW);
  assert.equal(tokens.refreshToken, "r2");
  assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
  assert.equal(new URLSearchParams(body).get("refresh_token"), "old-refresh");
});

test("failed token requests are reported with the status code", async () => {
  const fakeFetch: typeof fetch = async () => jsonResponse({ error: "invalid_grant" }, 400);
  await assert.rejects(exchangeCode(oauth, "bad", fakeFetch), (error: unknown) => {
    return error instanceof DonationAlertsError && /400/.test(error.message);
  });
});

test("donations are normalized, numeric strings included", () => {
  const rows = parseDonations({
    data: [
      { id: 30530030, username: "Ivan", amount: 500, currency: "RUB", message: "Hello!", created_at: "2019-09-29 09:00:00" },
      { id: "42", username: "Petr", amount: "250.50", currency: "RUB" },
      { id: "broken", username: "X", amount: 1, currency: "RUB" },
      { id: 5, username: "NoAmount", amount: "nope", currency: "RUB" },
      { id: 6, username: "NoCurrency", amount: 100 },
    ],
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 30530030,
    username: "Ivan",
    amount: 500,
    currency: "RUB",
    message: "Hello!",
    createdAt: "2019-09-29 09:00:00",
  });
  assert.equal(rows[1]?.id, 42);
  assert.equal(rows[1]?.amount, 250.5);
});

test("a response without data is an error, not an empty list", () => {
  assert.throws(() => parseDonations({}), DonationAlertsError);
});

test("fetchDonations sends the bearer token and returns rows", async () => {
  let authorization = "";
  const fakeFetch: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return jsonResponse({ data: [{ id: 1, username: "A", amount: 50, currency: "RUB" }] });
  };

  const rows = await fetchDonations("token-123", fakeFetch);
  assert.equal(authorization, "Bearer token-123");
  assert.equal(rows.length, 1);
});

test("an unauthorized poll fails loudly so the token refresh can happen", async () => {
  const fakeFetch: typeof fetch = async () => jsonResponse({ message: "Unauthenticated" }, 401);
  await assert.rejects(fetchDonations("expired", fakeFetch), /401/);
});

test("a burst that spans several pages is read completely, oldest rows included", async () => {
  const pages: Record<string, unknown> = {
    "1": {
      data: [
        { id: 105, username: "Newest", amount: 50, currency: "RUB" },
        { id: 104, username: "Second", amount: 50, currency: "RUB" },
      ],
      meta: { current_page: 1, last_page: 3 },
    },
    "2": {
      data: [
        { id: 103, username: "Third", amount: 50, currency: "RUB" },
        { id: 102, username: "Fourth", amount: 50, currency: "RUB" },
      ],
      meta: { current_page: 2, last_page: 3 },
    },
    "3": {
      data: [{ id: 101, username: "Oldest unseen", amount: 50, currency: "RUB" }],
      meta: { current_page: 3, last_page: 3 },
    },
  };

  const requested: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const page = new URL(String(input)).searchParams.get("page") ?? "1";
    requested.push(page);
    return jsonResponse(pages[page] ?? { data: [], meta: { current_page: Number(page), last_page: 3 } });
  };

  // The cursor is the id of the last donation already processed: everything above it is new.
  const rows = await fetchDonations("token", fakeFetch, { cursor: 100 });
  assert.deepEqual(rows.map((row) => row.id), [105, 104, 103, 102, 101]);
  assert.deepEqual(requested, ["1", "2", "3"], "the poll stopped before walking past last_page");
});

test("pagination stops on the page that reaches the processed cursor", async () => {
  const requested: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const page = new URL(String(input)).searchParams.get("page") ?? "1";
    requested.push(page);
    if (page === "1") {
      return jsonResponse({
        data: [
          { id: 9, username: "New", amount: 50, currency: "RUB" },
          { id: 8, username: "Already seen", amount: 50, currency: "RUB" },
        ],
        meta: { current_page: 1, last_page: 40 },
      });
    }
    return jsonResponse({ data: [{ id: 7, username: "Ancient", amount: 50, currency: "RUB" }] });
  };

  const rows = await fetchDonations("token", fakeFetch, { cursor: 8 });
  assert.deepEqual(rows.map((row) => row.id), [9, 8]);
  assert.deepEqual(requested, ["1"], "an older page was fetched although the cursor was already reached");
});

test("pagination is bounded by MAX_PAGES even when the feed never ends", async () => {
  const requested: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page") ?? "1");
    requested.push(String(page));
    return jsonResponse({
      data: [{ id: 1000 - page, username: `D${page}`, amount: 50, currency: "RUB" }],
      meta: { current_page: page, last_page: 999 },
    });
  };

  const rows = await fetchDonations("token", fakeFetch);
  assert.equal(requested.length, MAX_PAGES);
  assert.equal(rows.length, MAX_PAGES);
});

test("an empty page ends the walk instead of asking for page 3", async () => {
  const requested: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const page = new URL(String(input)).searchParams.get("page") ?? "1";
    requested.push(page);
    return jsonResponse({ data: page === "1" ? [{ id: 5, username: "A", amount: 50, currency: "RUB" }] : [] });
  };

  const rows = await fetchDonations("token", fakeFetch);
  assert.deepEqual(rows.map((row) => row.id), [5]);
  assert.deepEqual(requested, ["1", "2"]);
});
