import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uiSignature, type UiState } from "./state.ts";
import { renderPanelSvg } from "./template.ts";

/**
 * Keeps `ui.svg` on disk in sync with the state.
 *
 * Why SVG and not a rendered PNG: the picture is encoded in the capture container, which already
 * ships the DejaVu fonts and turns this file into a PNG with `rsvg-convert` (see
 * infra/stream/entrypoint.sh). A PNG renderer inside the control API would need a native npm
 * package, and that package is built for one platform - the Windows checkout could no longer start
 * the Linux container, because node_modules is mounted from the host.
 *
 * Three rules make it safe:
 *
 * - **always a whole file**: written to a temporary name and renamed, because a reader that lands on
 *   a half-written SVG renders a torn panel;
 * - **only when something changed**: `uiSignature` ignores the timestamp, so an idle server costs
 *   nothing and the CPU stays with the encoder;
 * - **never fatal**: a failed write is logged and the previous frame stays on screen - a bad panel
 *   must not take the stream down.
 */
export const UI_SVG = "ui.svg";
export const UI_JSON = "ui.json";
/**
 * A subdirectory, not the overlay root: the capture container runs as an unprivileged uid and has to
 * replace `ui.png` next to the SVG, while the overlay root itself belongs to this process. The
 * directory is opened up for it (`0777`) here, once.
 */
export const UI_DIR = "ui";
export const DEFAULT_INTERVAL_MS = 200;

export function writeUiFrame(dir: string, svg: string, state: UiState): void {
  const panelDir = join(dir, UI_DIR);
  mkdirSync(panelDir, { recursive: true });
  try {
    chmodSync(panelDir, 0o777);
  } catch {
    // Not fatal: a root-owned volume with a permissive default is fine, and a failure is reported
    // by the encoder in the log when it cannot write the PNG.
  }

  const svgPath = join(panelDir, UI_SVG);
  const svgTemporary = `${svgPath}.tmp`;
  writeFileSync(svgTemporary, svg, "utf8");
  renameSync(svgTemporary, svgPath);

  const jsonPath = join(panelDir, UI_JSON);
  const jsonTemporary = `${jsonPath}.tmp`;
  writeFileSync(jsonTemporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(jsonTemporary, jsonPath);
}

export interface UiLoopOptions {
  /** Shared with the encoder: the same volume that carries overlay.txt. */
  dir: string;
  getState: () => UiState;
  intervalMs?: number;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export class UiLoop {
  readonly #dir: string;
  readonly #getState: () => UiState;
  readonly #intervalMs: number;
  readonly #log: (event: string, details?: Record<string, unknown>) => void;
  #signature = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #failures = 0;

  constructor(options: UiLoopOptions) {
    this.#dir = options.dir;
    this.#getState = options.getState;
    this.#intervalMs = Math.max(50, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#log = options.log ?? (() => {});
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Renders now, even when nothing changed. Called once at startup so the encoder finds a frame
   * instead of falling back to the old text layer.
   */
  renderNow(): void {
    this.#signature = "";
    this.#tick();
  }

  #tick(): void {
    if (this.#stopped) return;
    try {
      const state = this.#getState();
      const signature = uiSignature(state);
      if (signature !== this.#signature) {
        writeUiFrame(this.#dir, renderPanelSvg(state), state);
        this.#signature = signature;
        if (this.#failures > 0) this.#log("ui.recovered", { failures: this.#failures });
        this.#failures = 0;
      }
    } catch (error) {
      this.#failures += 1;
      // Once per streak: a broken font or a full disk would otherwise log five times a second.
      if (this.#failures === 1) this.#log("ui.error", { error: (error as Error).message });
    } finally {
      if (!this.#stopped) this.#timer = setTimeout(() => this.#tick(), this.#intervalMs);
    }
  }
}
