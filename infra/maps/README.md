# Custom maps

The rotation (`map_duel_maps`) needs small, action-dense maps - a vertical 9:16 feed cannot wait five
seconds for the bots to meet. Two of them are arena maps that do not ship with HLDS, so they are
listed in `maps.json` and fetched by `infra/fetch-maps.ps1`.

## Fetching

```powershell
./infra/fetch-maps.ps1          # downloads what is missing, verifies the pins
./infra/fetch-maps.ps1 -Pin     # first run for a new entry: records the SHA256 (review the file first)
./infra/fetch-maps.ps1 -Only fy_iceworld -Force
```

Each entry in `maps.json` names a GameBanana **mod id** for Counter-Strike 1.6 - the same map name
also exists for CS2D and CS:GO, so the id is what pins the right upload - and a `sha256` of the
archive. The script checks GameBanana's own MD5 and its AV verdict on the way in, then the pin:
a re-uploaded or swapped file fails loudly instead of landing in the game. Archives arrive as `.zip`
or `.rar`; `tar.exe` (Windows 10+) unpacks both.

Two shapes of entry exist. A map that is not on GameBanana (`aim_aspect` came from DS-Servers by hand)
has no `mod` and a `source` URL instead of it, and its `sha256` is the pin of the `.bsp` itself: the
fetcher skips such an entry with `hand-added, not fetched`, and the reviewed file in git is the truth.
An archive with a solid `.rar` (`aim_aztecplace`) also needs 7-Zip by hand - bsdtar refuses solid
archives - so it is unpacked, copied, and the archive is pinned afterwards.

**Nothing is downloaded during an image build.** The image stays hermetic, and a map is exactly the
file that was reviewed and pinned in git.

## How a map reaches the game

`infra/maps` is mounted read-only into the hlds container at `/hlds/cstrike/maps-extra`, and
`infra/entrypoint.sh` copies what it finds next to the stock files at start
(`maps: N file(s) added from maps-extra` in the log). A stock file is never overwritten.

Placement matters, and it is decided by the extension:

| file | goes to |
|---|---|
| `.bsp` `.res` `.nav` `.txt` | `cstrike/maps/` |
| `.wad` | `cstrike/` - HLDS looks for wads there, and a missing one is fatal |
| `.wav` `.mp3` | `cstrike/sound/` |
| `.spr` / `.mdl` | `cstrike/sprites/` / `cstrike/models/` |

A `.bsp` alone is not enough: `fy_iceworld` ships `de_vegas.wad` and the server dies with
`FATAL ERROR: TEX_InitFromWad: couldn't open de_vegas.wad`, then comes back on the default map - which
looks exactly like "the map change was ignored". The fetcher copies the resources out of the archive
for this reason.

After adding files: `./infra/compose.ps1 restart hlds`. The capture container syncs missing files from
the server volume on every start (`--skip-old-files`), so the client can join a map that was added
after the volume was created.

## Bots need a graph, not a nav

YaPB 4.4 does not read Quake-style `.nav` files (an earlier version of this file claimed it did): it loads
`addons/yapb/data/graph/<map>.graph` and logs `Loaded Bots Graph data v2`. The archive ships graphs for the
stock maps only, so a map dropped in here is analyzed by the bot's own analyzer on first load, with the
result kept in the server volume - and lost whenever the volume is recreated.

A reviewed graph therefore goes into `graph/<map>.graph`; `infra/entrypoint.sh` copies it over the volume
copy on every start (`yapb graphs: N file(s) synced`). The file in git is the reviewed one, so it wins over
whatever the volume has. Regenerating one (`docs/runbook.md`, "Navigation graphs"):

```bash
docker run --rm -v cs16-youtube_server-data:/hlds --entrypoint sh cs16-hlds:local \
  -c 'rm -f /hlds/cstrike/addons/yapb/data/graph/my_map.graph'
# load my_map, wait for "Analysis finished", then:
docker cp cs16-shortchaos-hlds-1:/hlds/cstrike/addons/yapb/data/graph/my_map.graph infra/maps/graph/
```

## Adding a map by hand

Drop `my_map.bsp` (plus optional `.res` and `.txt`) into this directory, then put `my_map` into every
list that names the pool - `map_duel` is the only thing that rotates the map (`mp_timelimit` is 0):

1. `map_duel_maps` in `plugins/map_duel/map_duel.sma` - the real rotation;
2. `MAPCYCLE` in `infra/docker-compose.yml` **and** the same fallback in `infra/entrypoint.sh` - that is
   what `mapcycle.txt` is rewritten from on every start, i.e. the engine's own safety net (`nextmap`, a
   bare `changelevel`);
3. `MAP` in `infra/docker-compose.yml` if the server should boot onto it.

`test/map-duel-contract.test.ts` fails when the three lists disagree, when a name has no `.bsp` at all,
when a fetched map has no `sha256` pin, or when a map in the pool has no pinned graph.
