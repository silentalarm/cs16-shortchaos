import { execOnce } from "../src/rcon.ts";

/**
 * Walks the map rotation once and fires one activity on every map.
 *
 * A plugin change is otherwise checked on whichever map happened to be loaded, and the fy_ pool
 * differs in size, spawn count and bot paths enough that a class that works on fy_iceworld can leave
 * bots stuck on fy_aztec. Run it inside the control-api container, which already has RCON_*:
 *
 *   docker exec cs16-youtube-control-api-1 node scripts/map-walk.ts
 *   docker exec cs16-youtube-control-api-1 node scripts/map-walk.ts --maps fy_iceworld,fy_snow --code raptors
 *
 * Every line the server logs for the activity is echoed, so the output is the evidence, and a map
 * that does not load or an activity that fails to start is a non-zero exit.
 */
const args = process.argv.slice(2);

function arg(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined || value === "" ? fallback : value;
}

/** The pool from infra/docker-compose.yml: the stream must never fall back to a stock map. */
const DEFAULT_MAPS = "fy_iceworld,fy_pool_day,fy_snow,fy_buzzkill,fy_aztec,fy_dustworld";
/** One activity per map, chosen so every system is exercised somewhere in the walk. */
const DEFAULT_CODES = "nemesis,raptors,outbreak,jumpers,runners,brutes,regenerators";

const maps = arg("maps", DEFAULT_MAPS).split(",");
const codes = arg("codes", arg("code", DEFAULT_CODES)).split(",");
const settleSeconds = Number(arg("wait", "16"));
const holdSeconds = Number(arg("hold", "6"));

const options = {
  host: process.env["RCON_HOST"] ?? "127.0.0.1",
  port: Number(process.env["RCON_PORT"] ?? "27015"),
  password: process.env["RCON_PASSWORD"] ?? "",
  // A map change answers late: its log lines arrive while the new map is loading.
  timeoutMs: 15000,
};

if (options.password === "") {
  console.error("RCON_PASSWORD is not set: run this inside the control-api container");
  process.exit(1);
}

if (!Number.isFinite(settleSeconds) || settleSeconds < 0 || !Number.isFinite(holdSeconds) || holdSeconds < 0) {
  console.error("--wait and --hold must be non-negative seconds");
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rcon = (command: string): Promise<string> => execOnce(options, command);
const stamp = (): string => new Date().toISOString().slice(11, 19);

const failed: string[] = [];

for (const [index, map] of maps.entries()) {
  // A short list of codes repeats over a long list of maps, and one code repeats over all of them.
  const code = codes[index % codes.length] ?? codes[0] ?? "nemesis";

  console.log(`\n=== ${stamp()} ${map} -> ${code}`);

  try {
    await rcon(`changelevel ${map}`);
  } catch (error) {
    failed.push(`${map}: changelevel failed (${(error as Error).message})`);
    continue;
  }

  // Bots have to respawn and csdm_lite has to arm them: a class applied to an empty field proves
  // nothing about the map. The settle time is also when the new map finishes loading.
  await sleep(settleSeconds * 1000);

  // `status` is the only reply that names the map: the changelevel reply is a cvar dump, and a
  // missing .bsp falls back to the current map without an error anywhere in it.
  try {
    const current = /^map\s*:\s*(\S+)/mu.exec(await rcon("status"))?.[1] ?? "";
    if (current !== map) {
      failed.push(`${map}: the server is on ${current === "" ? "no map" : current}`);
      continue;
    }
  } catch (error) {
    failed.push(`${map}: status failed (${(error as Error).message})`);
    continue;
  }

  try {
    console.log(await rcon(`amx_de ${code}`));
  } catch (error) {
    failed.push(`${map}: ${code} failed (${(error as Error).message})`);
  }

  await sleep(holdSeconds * 1000);
}

console.log(`\n=== ${stamp()} walked ${maps.length} map(s)`);

if (failed.length > 0) {
  for (const line of failed) console.error(`FAILED ${line}`);
  process.exit(1);
}
