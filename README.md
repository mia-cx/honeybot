# Honeybot

Honeybot is a Discord.js moderation bot for catching scam and spam raids with honeypot channels, cross-channel repeat detection, known-scam evidence, embeddings, classifiers, and moderator review.

It is built for self-hosting: SQLite for persistence, filesystem evidence storage, Docker images, and Kubernetes/k3s manifests are all first-class deployment paths.

## Contents

- [Features](#features)
- [Discord app requirements](#discord-app-requirements)
- [Quick start](#quick-start)
- [Docker usage](#docker-usage)
- [Docker Compose](#docker-compose)
- [Kubernetes / Helm](#kubernetes--helm)
- [Configuration](#configuration)
- [Image tags](#image-tags)
- [Development](#development)
- [Docs](#docs)

## Features

- Honeypot channel triggers.
- Cross-channel repeated-content detection with a configurable S-curve time window.
- Known evidence corpus for exact, fuzzy, and embedding-based scam lookup.
- Text and multimodal image classifiers through OpenRouter-compatible model config.
- Per-guild policies for prevention and final punishment.
- Components V2 `/settings`, case review, corpus listing, and punishment DM UI.
- Moderator review buttons with separate case-moderator and Honeybot-configuration access.
- Optional global admin workflows for known scam corpus and global bans.
- Persistent SQLite state under `/app/data`.
- Filesystem evidence/image storage under `/app/data/images` by default.

## Discord app requirements

Enable these privileged gateway intents in the Discord Developer Portal:

- Server Members Intent
- Message Content Intent

Invite the bot with permissions for the actions you enable:

- View Channels
- Read Message History
- Manage Messages
- Moderate Members
- Ban Members, if using ban punishment
- Manage Roles, if using role punishment

## Quick start

```bash
pnpm install
cp .env.example .env
```

Fill in `.env`:

```bash
DISCORD_TOKEN=your-bot-token
OPENROUTER_API_KEY=optional-default-key
API_KEY_ENCRYPTION_KEY=base64-encoded-32-byte-key
```

Generate an encryption key with:

```bash
openssl rand -base64 32
```

Run locally:

```bash
pnpm dev
```

Configure guilds with `/settings` after the bot starts.

## Docker usage

Published images:

- Docker Hub: `miacx/honeybot`
- GHCR: `ghcr.io/mia-cx/honeybot`

Run with Docker Hub:

```bash
docker run -d \
  --name honeybot \
  --restart unless-stopped \
  -e DISCORD_TOKEN='your-bot-token' \
  -e OPENROUTER_API_KEY='optional-default-key' \
  -e API_KEY_ENCRYPTION_KEY='base64-encoded-32-byte-key' \
  -e GLOBAL_AUTH_MODE='team' \
  -e GLOBAL_AUTH_TEAM_ID='your-discord-app-team-id' \
  -v honeybot-data:/app/data \
  miacx/honeybot:latest
```

Run with GHCR:

```bash
docker run -d \
  --name honeybot \
  --restart unless-stopped \
  -e DISCORD_TOKEN='your-bot-token' \
  -e API_KEY_ENCRYPTION_KEY='base64-encoded-32-byte-key' \
  -v honeybot-data:/app/data \
  ghcr.io/mia-cx/honeybot:latest
```

There are no ports to publish. Honeybot only makes outbound connections to Discord and model providers.

### Volumes

| Path | Purpose |
| --- | --- |
| `/app/data` | SQLite database, stored evidence images, and runtime state |

Without a persistent volume, redeploys can lose config, cases, verbose-mode state, and known scam evidence.

## Docker Compose

A starter [`compose.yaml`](compose.yaml) is included.

Create a local `.env` for Compose variable substitution:

```bash
DISCORD_TOKEN=your-bot-token
OPENROUTER_API_KEY=optional-default-key
API_KEY_ENCRYPTION_KEY=base64-encoded-32-byte-key
GLOBAL_AUTH_MODE=team
GLOBAL_AUTH_TEAM_ID=your-discord-app-team-id
```

Start the bot:

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f honeybot
```

Update:

```bash
docker compose pull
docker compose up -d
```

## Kubernetes / Helm

This section is intentionally short enough to work well on Docker Hub too: image users can see the Helm install path without digging through the repo. Full chart docs live in [`charts/honeybot/README.md`](charts/honeybot/README.md).

Install with Helm:

```bash
helm upgrade --install honeybot ./charts/honeybot \
  --namespace honeybot --create-namespace \
  --set image.repository=miacx/honeybot \
  --set image.tag=latest \
  --set secrets.discordToken='your-bot-token' \
  --set secrets.openrouterApiKey='optional-default-key' \
  --set secrets.apiKeyEncryptionKey='base64-encoded-32-byte-key' \
  --set env.GLOBAL_AUTH_TEAM_ID='your-discord-app-team-id'
```

Raw k3s starter manifest:

```bash
kubectl apply -f k8s/honeybot.yaml
```

Kubernetes notes:

- Keep `replicaCount: 1`; Honeybot uses SQLite on a single-writer volume.
- The Helm chart uses `Recreate` rollout strategy to avoid two pods writing SQLite during upgrades.
- The pod runs as UID/GID `10001` and the chart sets `fsGroup: 10001` for PVC writability.

## Configuration

Honeybot reads ordinary environment variables from `process.env`. Docker, Compose, Kubernetes ConfigMaps, and Kubernetes Secrets all work without any special adapter.

Required:

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |

Recommended:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | unset | Deployment default model key. Guilds can also BYOK in Discord. |
| `API_KEY_ENCRYPTION_KEY` | unset | Base64 32-byte key for encrypting guild BYOK keys. |
| `GLOBAL_AUTH_MODE` | `team` | `team` or `users` global-admin mode. |
| `GLOBAL_AUTH_TEAM_ID` | unset | Discord Developer Team ID when `GLOBAL_AUTH_MODE=team`. |
| `GLOBAL_AUTH_USER_IDS` | empty | Comma-separated global admin user IDs when `GLOBAL_AUTH_MODE=users`. |
| `LOG_LEVEL` | `info` | Log verbosity. |

Storage defaults are hardcoded in the app:

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `file:data/honeybot.sqlite` |
| `IMAGE_STORAGE_DRIVER` | `filesystem` |
| `IMAGE_STORAGE_DIR` | `data/images` |

See [`.env.example`](.env.example) for every advanced model, queue, trigger, and policy default.

## Image tags

Images are versioned from `package.json`.

Stable version `1.2.3` publishes:

- `v1.2.3`
- `v1.2`
- `v1`
- `latest`
- `sha-...`

Beta version `1.2.3-beta` publishes:

- `v1.2.3-beta`
- `v1.2-beta`
- `v1-beta`
- `beta`
- `sha-...`

Build locally:

```bash
docker build -f docker/Dockerfile -t honeybot:local .
```

## Development

```bash
pnpm dev            # run with tsx watch
pnpm typecheck      # type-check only
pnpm build          # emit dist/
pnpm start          # run dist/src/index.js
pnpm lint           # lint source
pnpm test           # unit tests
pnpm eval:fixtures  # run classifier fixture evals
pnpm seed:fixtures  # seed fixture evidence corpus
```

GitHub Actions runs CI on PRs and pushes to `main`. Container builds publish multi-arch `linux/amd64` and `linux/arm64` images to GHCR and Docker Hub on `main` pushes.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — product and architecture notes
- [`docs/PLAN.md`](docs/PLAN.md) — implementation plan and schema notes
- [`PRIVACY.md`](PRIVACY.md) — privacy policy
- [`TERMS.md`](TERMS.md) — terms of service
