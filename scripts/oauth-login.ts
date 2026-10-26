import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { buildAuthorizeUrl, exchangeCode } from "../src/donationalerts.ts";
import { loadEnv } from "../src/env.ts";
import { TokenStore } from "../src/token-store.ts";

/**
 * One-off OAuth helper: prints the authorize URL, waits for the redirect on the configured
 * callback, exchanges the code and writes data/da-token.json. Run it once per account.
 */
const env = loadEnv();
const state = randomBytes(8).toString("hex");
const port = Number(new URL(env.da.redirectUri).port || 4318);

if (env.da.clientId === "" || env.da.clientSecret === "") {
  console.error("DA_CLIENT_ID and DA_CLIENT_SECRET must be set in .env (register an application in DonationAlerts)");
  process.exit(1);
}

const authorizeUrl = buildAuthorizeUrl({
  clientId: env.da.clientId,
  clientSecret: env.da.clientSecret,
  redirectUri: env.da.redirectUri,
  scopes: env.da.scopes,
  state,
});

console.log("Open this URL in a browser, sign in as the streamer and approve the app:\n");
console.log(`${authorizeUrl}\n`);
console.log(`Waiting for the redirect on port ${port} ...`);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", env.da.redirectUri);

  if (url.pathname !== new URL(env.da.redirectUri).pathname) {
    response.writeHead(404).end("not found");
    return;
  }

  if (url.searchParams.get("state") !== state) {
    response.writeHead(400).end("state mismatch");
    console.error("state mismatch, ignoring the callback");
    return;
  }

  const code = url.searchParams.get("code");
  if (code === null) {
    response.writeHead(400).end("no code");
    console.error("callback has no code");
    return;
  }

  exchangeCode(
    { clientId: env.da.clientId, clientSecret: env.da.clientSecret, redirectUri: env.da.redirectUri },
    code,
  ).then(
    (tokens) => {
      new TokenStore("data/da-token.json").save(tokens);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("tokens saved, you can close this tab");
      console.log(`tokens saved to data/da-token.json, expires at ${new Date(tokens.expiresAt).toISOString()}`);
      server.close();
      process.exit(0);
    },
    (error: Error) => {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end("token exchange failed");
      console.error(`token exchange failed: ${error.message}`);
      server.close();
      process.exit(1);
    },
  );
});

server.listen(port, "127.0.0.1");
