# Video title-slide burn-in — AWS Batch job container.
#
# IMPORTANT: build context is the padmakara-api REPO ROOT, not this
# directory — the image needs the shared slide renderer from
# src/lib/slides/, which lives outside containers/video-burn/. Build from
# padmakara-api/:
#
#   docker build -f containers/video-burn/Dockerfile -t padmakara-video-burn .
#
# See README.md in this directory for the full build/test/push workflow and
# docs/runbooks/video-burn-provisioning.md for the one-time AWS setup.

FROM node:22-bookworm-slim

# ffmpeg: encodes slide segments and does the final concat.
# chromium: headless-screenshots the shared HTML slide renderer.
# fonts-liberation: sane fallback metrics if a slide ever references a
#   glyph MinionPro doesn't cover (CJK, unusual punctuation, etc).
# ca-certificates: chromium/node HTTPS to S3 + Bunny.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
      fonts-liberation \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Preserve the SAME relative path from containers/video-burn/ to
# src/lib/slides/ that exists in the repo, so entrypoint.ts's relative
# imports ("../../src/lib/slides/...") resolve identically here and on a
# dev machine.
COPY src/lib/slides ./src/lib/slides

WORKDIR /app/containers/video-burn
COPY containers/video-burn/package.json containers/video-burn/tsconfig.json ./
# playwright-core (unlike the `playwright` metapackage) never downloads a
# browser on install — it only drives whatever executablePath it's given,
# which entrypoint.ts points at the apt-installed chromium above.
RUN npm install --omit=dev
COPY containers/video-burn/*.ts ./
COPY containers/video-burn/fonts ./fonts
COPY containers/video-burn/assets ./assets

ENV CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

ENTRYPOINT ["npx", "tsx", "entrypoint.ts"]
