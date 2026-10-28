import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { panelLayers, type PanelLayer } from "./panel.ts";
import { uiSignature, type UiState } from "./state.ts";

/**
 * Keeps the panel files on disk in sync with the state.
 *
 * The encoder draws every line itself with `drawtext` and re-reads the file on each frame
 * (`reload=1`), so writing a file *is* updating the picture - no second ffmpeg input, no
 * rasteriser, no synchronisation. See `ui/panel.ts` for why the panel is text at all.
 *
 * Three rules make it safe:
 *
 * - **always a whole file**: written to a temporary name and renamed, because a reader that lands on
 *   a half-written line draws a torn line;
 * - **only when something changed**: `uiSignature` ignores the timestamp, so an idle server costs
 *   nothing and the CPU stays with the encoder;
 * - **never fatal**: a failed write is logged and the previous frame stays on screen - a bad panel
 *   must not take the stream down.
 */
/** The state dump, for the admin page and for debugging; the encoder never reads it. */
export const UI_JSON = "ui.json";
/**
 * A subdirectory, not the overlay root: the donation text (`overlay.txt`) is written by the same
 * process, and the panel files are opened up (`0777`) so the unprivileged capture container can
 * read them from a volume created by another uid.
 */
export const UI_DIR = "ui";
export const DEFAULT_INTERVAL_MS = 200;

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

export function writeUiFrame(dir: string, layers: readonly PanelLayer[], state: UiState): void {
  const panelDir = join(dir, UI_DIR);
  mkdirSync(panelDir, { recursive: true });
  try {
    chmodSync(panelDir, 0o777);
  } catch {
    // Not fatal: a root-owned volume with a permissive default is fine, and a failure shows up as a
    // line that never changes instead of a broken stream.
  }

  for (const layer of layers) {
    // No trailing newline: drawtext would count it as a second, empty line and change the height of
    // the block it centres vertically.
    writeAtomic(join(panelDir, layer.file), layer.text);
  }
  writeAtomic(join(panelDir, UI_JSON), `${JSON.stringify(state, null, 2)}\n`);
}

export interface UiLoopOptions {
  /** Shared with the encoder: the same volume that carries overlay.txt. */
  dir: string;
  getState: () => UiState;
  intervalMs?: number;
  /** Blocks per side of the score bar; 20 fits the 720 px frame at the default font size. */
  segments?: number;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export class UiLoop {
  readonly #dir: string;
  readonly #getState: () => UiState;
  readonly #intervalMs: number;
  readonly #segments: number | undefined;
  readonly #log: (event: string, details?: Record<string, unknown>) => void;
  #signature = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #failures = 0;

  constructor(options: UiLoopOptions) {
    this.#dir = options.dir;
    this.#getState = options.getState;
    this.#intervalMs = Math.max(50, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#segments = options.segments;
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
   * Writes now, even when nothing changed. Called once at startup so the encoder finds a panel
   * instead of empty lines for the first seconds.
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
        writeUiFrame(this.#dir, panelLayers(state, this.#segments), state);
        this.#signature = signature;
        if (this.#failures > 0) this.#log("ui.recovered", { failures: this.#failures });
        this.#failures = 0;
      }
    } catch (error) {
      this.#failures += 1;
      // Once per streak: a full disk would otherwise log five times a second.
      if (this.#failures === 1) this.#log("ui.error", { error: (error as Error).message });
    } finally {
      if (!this.#stopped) this.#timer = setTimeout(() => this.#tick(), this.#intervalMs);
    }
  }
}

