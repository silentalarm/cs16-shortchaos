import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tokens } from "./donationalerts.ts";

/**
 * OAuth tokens live outside the repository (data/ is gitignored) and are written with
 * owner-only permissions. Nothing here is ever logged.
 */
export class TokenStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Tokens | null {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch {
      return null;
    }

    try {
      const raw = JSON.parse(text) as Partial<Tokens>;
      if (typeof raw.accessToken !== "string" || typeof raw.refreshToken !== "string") return null;
      if (typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) return null;
      return { accessToken: raw.accessToken, refreshToken: raw.refreshToken, expiresAt: raw.expiresAt };
    } catch {
      return null;
    }
  }

  save(tokens: Tokens): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  /** Refreshes five minutes early so a poll never races with token expiry. */
  isExpiring(tokens: Tokens, now = Date.now(), marginMs = 5 * 60_000): boolean {
    return tokens.expiresAt - marginMs <= now;
  }
}
