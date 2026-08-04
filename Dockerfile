# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
# syntax=docker/dockerfile:1
#
# OpenMasjid Display — multi-stage, multi-arch (amd64 + arm64).
# The JS build stages run on the native BUILD platform (fast, arch-independent
# output); only the runtime stage runs as the TARGET arch, where `npm ci` pulls
# the correct @resvg/resvg-js native binary for that architecture.

# ---- The RTSP server (MediaMTX) -------------------------------------------
# Taken from the official multi-arch image, pinned by version. This stage has no
# --platform override, so it is pulled for the TARGET architecture — the arm64
# build gets the arm64 binary, the amd64 build gets the amd64 one.
FROM bluenviron/mediamtx:1.19.3@sha256:7797ed3df88df21e8c04ecd0aff08ce49a5232d1db453e51f5480ef36bc80865 AS mediamtx

# ---- Build the web control panel (Vite → static files) --------------------
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Compile the server (TypeScript → dist) -------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Runtime (target architecture) ----------------------------------------
FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="OpenMasjid Display" \
      org.opencontainers.image.description="Prayer timetables, cameras and HDMI to every screen in your masjid, over RTSP." \
      org.opencontainers.image.source="https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay" \
      org.opencontainers.image.licenses="AGPL-3.0"

# ffmpeg encodes the timetable video; fonts let resvg draw Latin + Arabic text
# (baked into the image so rendering is identical on every host); tini reaps the
# ffmpeg child processes and forwards signals cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      fonts-noto-core \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Production deps only — this resolves the per-arch @resvg/resvg-js prebuilt binary.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=server /server/dist ./dist
COPY --from=web /web/dist ./public

# Vendored fonts (loaded with priority by render/fonts.ts). We bundle a STATIC Noto
# Naskh Arabic that is verified to contain the ﷺ ligature (U+FDFA); the distro's
# variable Noto Naskh can drop it to a tofu box under resvg. See assets/fonts/README.md.
COPY server/assets/fonts /app/fonts

# The RTSP server runs inside this container too, so a masjid installs and updates
# exactly one thing. The app launches and supervises it (mediamtxServer.ts). We ship
# MediaMTX's OWN default config — it includes the `all_others` path that lets the
# timetable renderer publish into MediaMTX and each screen's path relay from it — and
# tune only what we need through MTX_* env vars below (these override the file).
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY --from=mediamtx /mediamtx.yml /app/mediamtx.yml

ENV PORT=8080 \
    VOLUNTEER_PORT=8081 \
    VOLUNTEER_PUBLIC_PORT=7861 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    MTX_API=yes \
    MTX_APIADDRESS=127.0.0.1:9997 \
    MTX_RTSPTRANSPORTS=tcp \
    MTX_RTMP=no \
    MTX_HLS=no \
    MTX_WEBRTC=no \
    MTX_SRT=no
EXPOSE 8080 8081 8554
VOLUME ["/data"]

# Let the host see whether the app is actually SERVING, not merely running. The app has
# always exposed /healthz and nothing used it, so an orchestrator had no way to notice a
# process that was up but not answering. Uses node's built-in fetch — no extra package.
#
# Deliberately process liveness only, NOT render freshness: a screen showing a stale
# timetable is reported through /api/state and the Fabric alert instead. Restarting the
# whole container (every screen, plus MediaMTX) because one timetable went stale would
# turn a one-screen fault into an outage, and a persistent cause would restart-loop.
# (DISPLAY-019)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
