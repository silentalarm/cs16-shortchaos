import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.ts";

/**
 * `process.loadEnvFile` ignores a byte order mark and cannot parse a UTF-16 file, and in both cases
 * it reports nothing: every variable simply reads as unset. Measured on Node 24.22.0 - a BOM in
 * front of the first line is enough to lose that one key, which the operator sees as "the value I
 * typed is not there". These tests keep the guard honest instead of trusting the note in `env.ts`.
 */
function scratchFile(name: string, bytes: string | Buffer): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "cs16-env-"));
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return { dir, file };
}

/** `loadEnv` writes straight into the process environment, so the names must not leak to other tests. */
function forget(): void {
  delete process.env["DA_CLIENT_ID"];
  delete process.env["DA_CLIENT_SECRET"];
  delete process.env["DA_MOCK"];
  // This shell exports the project's env, so the defaults are only visible once the ambient values go.
  delete process.env["ADMIN_PORT"];
}

test("a plain UTF-8 env file is read", () => {
  const { dir, file } = scratchFile("plain.txt", "DA_CLIENT_ID=12345\nDA_CLIENT_SECRET=abc\n");
  try {
    forget();
    const env = loadEnv(file);
    assert.equal(env.da.clientId, "12345");
    assert.equal(env.da.clientSecret, "abc");
  } finally {
    forget();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a UTF-8 BOM is refused, because Node would silently drop the first key", () => {
  const body = Buffer.from("DA_CLIENT_ID=12345\n", "utf8");
  const { dir, file } = scratchFile("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  try {
    forget();
    assert.throws(() => loadEnv(file), /UTF-8 with a BOM/);
    assert.equal(process.env["DA_CLIENT_ID"], undefined);
  } finally {
    forget();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a UTF-16 env file is refused, because Node reads no variable from it at all", () => {
  const body = Buffer.from("DA_CLIENT_ID=12345\n", "utf16le");
  const { dir, file } = scratchFile("utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
  try {
    forget();
    assert.throws(() => loadEnv(file), /UTF-16/);
    assert.equal(process.env["DA_CLIENT_ID"], undefined);
  } finally {
    forget();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing env file is not an error: the defaults stand", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-env-"));
  try {
    forget();
    const env = loadEnv(join(dir, "absent.txt"));
    assert.equal(env.mock, false);
    assert.equal(env.da.clientId, "");
    assert.equal(env.admin.port, 8080);
  } finally {
    forget();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `.env.example` is tracked by git, so a real API key pasted into it is published on the next push.
 * The template keeps every key and every default, but the secrets stay empty: they belong in `.env`
 * alone, which is ignored. This covers every secret the project reads, not just the DA pair.
 */
test(".env.example ships empty secrets", () => {
  const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const key of ["DA_CLIENT_ID", "DA_CLIENT_SECRET", "RCON_PASSWORD", "YOUTUBE_STREAM_KEY", "ADMIN_TOKEN"]) {
    const match = new RegExp(`^[ \\t]*${key}[ \\t]*=(.*)$`, "m").exec(text);
    assert.ok(match !== null, `${key} must stay documented in the template`);
    assert.equal((match[1] ?? "").trim(), "", `${key} must be empty in the tracked template`);
  }
});
