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

## Adding a map by hand

Drop `my_map.bsp` (plus optional `.res`, `.txt` and `.nav` - without a `.nav` YaPB walks blind) into
this directory, then put `my_map` into **both** lists:

1. `map_duel_maps` in `plugins/map_duel/map_duel.sma` (or override the cvar in `infra/server.cfg`),
2. `params.maps` of the `map_change` activity in `config/activities.json`.

`test/map-duel-contract.test.ts` fails when the two disagree, when a name has no `.bsp` at all, or
when a fetched map has no `sha256` pin.
