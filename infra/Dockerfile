# syntax=docker/dockerfile:1.7
# Base image must be pinned by digest before production:
#   docker buildx imagetools inspect debian:bookworm-slim   -> debian@sha256:...
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE} AS build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils lib32gcc-s1 lib32stdc++6 lib32z1 \
 && rm -rf /var/lib/apt/lists/*

# Every URL and its SHA256 come from infra/checksums.env (generated, never guessed).
# Build with infra/build-image.ps1: it expands that file into --build-arg (older buildx
# builds have no --build-arg-file).
ARG REHLDS_URL REHLDS_SHA256
ARG REGAMEDLL_URL REGAMEDLL_SHA256
ARG METAMOD_URL METAMOD_SHA256
ARG AMXX_BASE_URL AMXX_BASE_SHA256
ARG AMXX_CSTRIKE_URL AMXX_CSTRIKE_SHA256
ARG YAPB_URL YAPB_SHA256
# 1 = replace the Valve engine with ReHLDS. Requires the legacy engine libraries below:
# the current public depot's steamclient.so no longer exports SteamGameServer_Init.
ARG WITH_REHLDS=1
# 1 = replace the game DLL with ReGameDLL_CS (built against ReHLDS; off by default).
ARG WITH_REGAMEDLL=0
# Pinned manifest of app 90 depot 4 ("steam_legacy" branch, pre-25th-anniversary build).
ARG STEAM_LEGACY_MANIFEST=8690279432129063737

ENV WITH_REHLDS=${WITH_REHLDS} WITH_REGAMEDLL=${WITH_REGAMEDLL} \
    STEAM_LEGACY_MANIFEST=${STEAM_LEGACY_MANIFEST} \
    REHLDS_URL=${REHLDS_URL} REHLDS_SHA256=${REHLDS_SHA256} \
    REGAMEDLL_URL=${REGAMEDLL_URL} REGAMEDLL_SHA256=${REGAMEDLL_SHA256} \
    METAMOD_URL=${METAMOD_URL} METAMOD_SHA256=${METAMOD_SHA256} \
    AMXX_BASE_URL=${AMXX_BASE_URL} AMXX_BASE_SHA256=${AMXX_BASE_SHA256} \
    AMXX_CSTRIKE_URL=${AMXX_CSTRIKE_URL} AMXX_CSTRIKE_SHA256=${AMXX_CSTRIKE_SHA256} \
    YAPB_URL=${YAPB_URL} YAPB_SHA256=${YAPB_SHA256}

COPY infra/build-hlds.sh /usr/local/bin/build-hlds.sh
COPY infra/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN --mount=type=cache,target=/var/cache/steamcmd \
    chmod +x /usr/local/bin/build-hlds.sh /usr/local/bin/entrypoint.sh \
 && bash /usr/local/bin/build-hlds.sh

# amxxpc is a 32-bit binary: it needs the i386 loader, which the base deps above lack.
# Everything from here on is cheap to rebuild, so editing the Pawn plugin re-runs only
# the compile step instead of re-downloading the game server.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libc6-i386 \
 && rm -rf /var/lib/apt/lists/*

COPY infra/build-plugin.sh /usr/local/bin/build-plugin.sh
COPY infra/server.cfg /src/server.cfg
COPY infra/plugins.ini /src/plugins.ini
COPY plugins /src/plugins

# stream_cam needs the cstrike module to assign the camera a team, and the base AMXX package ships
# the whole module list commented out.
RUN chmod +x /usr/local/bin/build-plugin.sh \
 && bash /usr/local/bin/build-plugin.sh \
 && cp /src/plugins.ini /hlds/cstrike/addons/amxmodx/configs/plugins.ini \
 && cp /src/server.cfg /hlds/cstrike/server.cfg \
 && sed -i 's/^;cstrike\(\r\?\)$/cstrike\1/' /hlds/cstrike/addons/amxmodx/configs/modules.ini \
 && grep -qx 'cstrike' /hlds/cstrike/addons/amxmodx/configs/modules.ini

FROM ${BASE_IMAGE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends ca-certificates lib32gcc-s1 lib32stdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /hlds --shell /usr/sbin/nologin hlds

COPY --from=build --chown=10001:10001 /hlds /hlds

# /hlds is a named volume at runtime, and Docker seeds a volume from the image only once. A rebuilt
# plugin or an edited config would therefore never reach an existing volume, which makes image
# updates silently ineffective. Pristine copies live outside the mount point; the entrypoint syncs
# them over the volume on every start.
COPY --from=build --chown=10001:10001 /hlds/cstrike/server.cfg /opt/defaults/server.cfg
COPY --from=build --chown=10001:10001 /hlds/cstrike/addons/amxmodx/configs/plugins.ini /opt/defaults/plugins.ini
COPY --from=build --chown=10001:10001 /hlds/cstrike/addons/amxmodx/configs/modules.ini /opt/defaults/modules.ini
COPY --from=build --chown=10001:10001 /hlds/cstrike/addons/amxmodx/plugins /opt/defaults/plugins

# The entrypoint must live outside /hlds: that directory is a named volume in compose, and a
# volume is populated from the image only once. An entrypoint stored there would keep executing
# the copy from the first image version forever, silently ignoring updates.
COPY infra/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER 10001
WORKDIR /hlds
EXPOSE 27015/tcp
EXPOSE 27015/udp

# pgrep lives in procps, which this image does not install; the server's own /proc entry is enough
# and needs nothing but grep. `hlds_run` execs `hlds_linux`, so the comm name contains "hlds".
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/bin/sh", "-c", "grep -l hlds /proc/[0-9]*/comm >/dev/null 2>&1 || exit 1"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
