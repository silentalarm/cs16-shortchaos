import type { ActivitiesConfig, Activity } from "../activities.ts";
import { overriddenCodes } from "../activities-override.ts";
import type { OverrideDocument } from "../activities-override.ts";
import type { AdminAction, Store, StoredDonation } from "../db.ts";
import { parsePluginStatus, readStreamHealth } from "../stream-status.ts";
import type { PluginStatus, StreamHealth } from "../stream-status.ts";

/**
 * Everything the panel renders, assembled in one place. The panel asks for this object every two
 * seconds instead of keeping its own copy of the catalogue: the control API owns the state, the
 * browser only draws it.
 */
export const STATUS_COMMAND = "amx_de status";
/** `map_duel status: state=<idle|live|done> winner=<name|->` - who owns the last minute of the map. */
export const DUEL_STATUS_COMMAND = "amx_map_duel status";

export interface ActivityView extends Activity {
  /** true when a runtime override changed this row, so the UI can offer "reset". */
  overridden: boolean;
}

/**
 * Where the page should pull the picture from. The browser builds the URL itself (same host, given
 * port), so the panel works both on 127.0.0.1 and from another machine in the LAN.
 */
export interface PlaybackInfo {
  /** MediaMTX HLS port, published on the host. */
  port: number;
  /** MediaMTX path name, e.g. "live/test". */
  path: string;
}

export interface AdminState {
  now: string;
  mode: {
    mock: boolean;
    dryRun: boolean;
    simAllowed: boolean;
    currency: string;
    minAmount: number;
  };
  activities: ActivityView[];
  overridden: string[];
  active: PluginStatus | null;
  statusError: string | null;
  donations: StoredDonation[];
  adminActions: AdminAction[];
  stream: StreamHealth;
  playback: PlaybackInfo;
}

export interface StateDeps {
  store: Store;
  getCatalog: () => ActivitiesConfig;
  getOverrides: () => OverrideDocument;
  apply: (command: string) => Promise<string>;
  streamStatusDir: string;
  playback: PlaybackInfo;
  mode: { mock: boolean; dryRun: boolean; simAllowed: boolean };
  now?: () => number;
}

export async function buildState(deps: StateDeps): Promise<AdminState> {
  const catalog = deps.getCatalog();
  const overridden = overriddenCodes(deps.getOverrides());
  const now = deps.now ?? (() => Date.now());

  // A panel that cannot reach the game server must still render prices and history: the status
  // probe failure is reported next to the rest instead of failing the whole request.
  let active: PluginStatus | null = null;
  let statusError: string | null = null;
  try {
    active = parsePluginStatus(await deps.apply(STATUS_COMMAND));
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error);
  }

  return {
    now: new Date(now()).toISOString(),
    mode: { ...deps.mode, currency: catalog.currency, minAmount: catalog.minAmount },
    activities: catalog.activities.map((activity) => ({ ...activity, overridden: overridden.includes(activity.code) })),
    overridden,
    active,
    statusError,
    donations: deps.store.recent(20),
    adminActions: deps.store.recentAdminActions(10),
    stream: readStreamHealth(deps.streamStatusDir, now()),
    playback: deps.playback,
  };
}
