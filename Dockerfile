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
FROM bluenviron/mediamtx:1.19.1 AS mediamtx

# ---- Build the web control panel (Vite → static files) --------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Compile the server (TypeScript → dist) -------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Runtime (target architecture) ----------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="OpenMasjid Display" \
      org.opencontainers.image.description="Prayer timetables, cameras and HDMI to every screen in your masjid, over RTSP." \
      org.opencontainers.image.source="https://github.com/hasan-ismail/OpenMasjidDisplay" \
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

# The RTSP server runs inside this container too, so a masjid installs and updates
# exactly one thing. The app launches and supervises it (mediamtxServer.ts). We ship
# MediaMTX's OWN default config — it includes the `all_others` path that lets the
# timetable renderer publish into MediaMTX and each screen's path relay from it — and
# tune only what we need through MTX_* env vars below (these override the file).
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY --from=mediamtx /mediamtx.yml /app/mediamtx.yml

ENV PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public \
    MTX_API=yes \
    MTX_APIADDRESS=127.0.0.1:9997 \
    MTX_RTSPTRANSPORTS=tcp \
    MTX_RTMP=no \
    MTX_HLS=no \
    MTX_WEBRTC=no \
    MTX_SRT=no
EXPOSE 8080 8554
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
