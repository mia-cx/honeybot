# syntax=docker/dockerfile:1.7

FROM node:24-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app
RUN corepack enable

FROM base AS deps

ENV NODE_ENV=development
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM base AS runtime

ARG HONEYBOT_UID=10001
ARG HONEYBOT_GID=10001

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid "${HONEYBOT_GID}" honeybot \
  && useradd --system --uid "${HONEYBOT_UID}" --gid honeybot --home-dir /app honeybot

COPY --from=build --chown=honeybot:honeybot /app/package.json ./package.json
COPY --from=build --chown=honeybot:honeybot /app/node_modules ./node_modules
COPY --from=build --chown=honeybot:honeybot /app/dist ./dist
COPY --from=build --chown=honeybot:honeybot /app/prompts ./prompts

RUN mkdir -p data/images \
  && chown -R honeybot:honeybot data

USER honeybot
VOLUME ["/app/data"]

CMD ["node", "dist/src/index.js"]
