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
- [Releases and changelogs](#releases-and-changelogs)
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

Default install scopes:

| Install type | Scopes |
| --- | --- |
| User install | `applications.commands` |
| Guild install | `applications.commands`, `bot` |

Default guild-install permissions:

- Attach Files
- Ban Members
- Embed Links
- Kick Members
- Manage Channels
- Manage Messages
- Manage Roles
- Moderate Members
- Send Messages
- Send Messages in Threads
- Use External Emojis
- Use Slash Commands
- View Audit Log
- View Channels

Some permissions are only needed when the matching moderation policy is enabled, but the default install set lets every Honeybot feature work without regenerating the invite.

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

Create a local `.env`; Compose loads it into the container via `env_file`:

```bash
cp .env.example .env
```

Then fill in at least:

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

Notes:

- `DISCORD_TOKEN` is the only required variable.
- Empty strings are treated as omitted for optional values.
- Comma-separated variables ignore blank entries.
- Booleans accept `true/false`, `1/0`, `yes/no`, and `on/off`.
- Deployment guild defaults only affect newly initialized guild config. Existing SQLite guild settings are not overwritten.

### Core runtime

| Variable | Default if omitted | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | **Required** | Discord bot token from the Developer Portal. |
| `LOG_LEVEL` | `info` | Logger verbosity: `debug`, `info`, `warn`, or `error`. |
| `DATABASE_URL` | `file:data/honeybot.sqlite` | SQLite database URL for durable bot state. |
| `IMAGE_STORAGE_DRIVER` | `filesystem` | Evidence/image storage backend. Only `filesystem` is currently supported. |
| `IMAGE_STORAGE_DIR` | `data/images` | Directory for stored evidence images when using filesystem storage. |
| `API_KEY_ENCRYPTION_KEY` | unset | Base64 32-byte key for encrypting guild BYOK model API keys. Losing it makes stored keys unrecoverable. |
| `OPENROUTER_API_KEY` | unset | Deployment default OpenRouter API key. Guild BYOK keys can override this per purpose. |
| `EVAL_CORPUS_DIR` | unset | Optional local/private fixture corpus directory for eval scripts. |

### Model defaults

| Variable | Default if omitted | What it does |
| --- | --- | --- |
| `DEFAULT_TEXT_PRIMARY_PROVIDER` | `openrouter` | Provider used by the primary text-only scam classifier. |
| `DEFAULT_TEXT_PRIMARY_MODEL` | `google/gemma-4-31b-it` | Model ID used by the primary text-only scam classifier. |
| `DEFAULT_IMAGE_PRIMARY_PROVIDER` | `openrouter` | Provider used by the primary multimodal image classifier. |
| `DEFAULT_IMAGE_PRIMARY_MODEL` | `google/gemma-4-31b-it` | Model ID used by the primary multimodal image classifier. |
| `ADDITIONAL_TEXT_SIGNAL_PROVIDER` | `openrouter` | Provider for optional advisory text classifiers. |
| `ADDITIONAL_TEXT_SIGNAL_MODELS` | empty list | Comma-separated advisory text classifier model IDs. Advisory signals do not independently trigger auto-punishment. |
| `ADDITIONAL_IMAGE_SIGNAL_PROVIDER` | `openrouter` | Provider for optional advisory image classifiers. |
| `ADDITIONAL_IMAGE_SIGNAL_MODELS` | empty list | Comma-separated advisory image classifier model IDs. Advisory signals do not independently trigger auto-punishment. |
| `DEFAULT_TEXT_EMBEDDINGS_PROVIDER` | `openrouter` | Provider used for text embeddings. |
| `DEFAULT_TEXT_EMBEDDINGS_MODEL` | `nvidia/llama-nemotron-embed-vl-1b-v2:free` | Model ID used for text embeddings and text corpus vectors. |
| `DEFAULT_IMAGE_EMBEDDINGS_PROVIDER` | `openrouter` | Provider used for image embeddings. |
| `DEFAULT_IMAGE_EMBEDDINGS_MODEL` | `nvidia/llama-nemotron-embed-vl-1b-v2:free` | Model ID used for image embeddings and image corpus vectors. |
| `DEFAULT_EMBEDDINGS_DIMENSIONS` | `2048` | Expected embedding vector size. Nemotron returns fixed 2048-dimension vectors. |

### Rate limits and retries

| Variable | Default if omitted | What it does |
| --- | --- | --- |
| `MODEL_CALL_LIMIT` | `6000` | Deployment-wide rolling-window model/provider call limit. |
| `MODEL_CALL_LIMIT_PER_GUILD` | `20` | Per-guild rolling-window model/provider call limit. |
| `MODEL_CALL_WINDOW_SECONDS` | `60` | Rolling-window duration for model call limits. |
| `MODEL_RETRY_MAX_ATTEMPTS` | `3` | Maximum retry attempts for transient model/provider failures. |
| `MODEL_RETRY_INITIAL_DELAY_MS` | `300` | Initial exponential-backoff delay for model retries. |
| `MODEL_RETRY_MAX_DELAY_MS` | `15000` | Maximum exponential-backoff delay for model retries. |
| `MODERATION_ACTION_LIMIT` | `30` | Deployment-wide rolling-window Discord moderation action limit. |
| `MODERATION_ACTION_LIMIT_PER_GUILD` | `10` | Per-guild rolling-window Discord moderation action limit. |
| `MODERATION_ACTION_WINDOW_SECONDS` | `60` | Rolling-window duration for moderation action limits. |

### Global-admin authority

| Variable | Default if omitted | What it does |
| --- | --- | --- |
| `GLOBAL_AUTH_MODE` | `team` | Global admin mode: `team` checks Discord Developer Team membership; `users` checks `GLOBAL_AUTH_USER_IDS`. |
| `GLOBAL_AUTH_TEAM_ID` | unset | Discord Developer Team ID used when `GLOBAL_AUTH_MODE=team`. |
| `GLOBAL_AUTH_USER_IDS` | empty string | Comma-separated Discord user IDs granted global authority when `GLOBAL_AUTH_MODE=users`. |

### Deployment defaults for new guilds

| Variable | Default if omitted | What it does |
| --- | --- | --- |
| `HONEYBOT_DEFAULT_MODERATION_CHANNEL_ID` | unset | Default moderation/case-feed channel ID. |
| `HONEYBOT_DEFAULT_HONEYPOT_CHANNEL_IDS` | empty list | Comma-separated default honeypot channel IDs. |
| `HONEYBOT_DEFAULT_MODERATOR_USER_IDS` | empty list | Comma-separated default case-moderator user IDs. |
| `HONEYBOT_DEFAULT_MODERATOR_ROLE_IDS` | empty list | Comma-separated default case-moderator role IDs. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_ENABLED` | `true` | Enables cross-channel repeated-content trigger for newly initialized guilds. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_MINIMUM_WINDOW_SECONDS` | `5` | Minimum cross-channel match window at the 2-channel threshold. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_SECONDS` | `3600` | Maximum/asymptotic cross-channel match window. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_STEEPNESS` | `0.49` | Steepness for the normalized logistic cross-channel window curve. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_WINDOW_MIDPOINT_CHANNELS` | `13` | Channel count at the midpoint of the cross-channel window curve. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_CHANNEL_THRESHOLD` | `2` | Number of channels needed to trigger cross-channel detection. |
| `HONEYBOT_DEFAULT_KNOWN_IMAGE_SIMILARITY_THRESHOLD` | `0.92` | Similarity threshold for known image evidence matches. |
| `HONEYBOT_DEFAULT_KNOWN_TEXT_SIMILARITY_THRESHOLD` | `0.82` | Similarity threshold for known text evidence matches. |
| `HONEYBOT_DEFAULT_EVIDENCE_CONFIDENCE_THRESHOLD` | `0.90` | Confidence threshold used by review-bypass auto-punishment. |
| `HONEYBOT_DEFAULT_AUTO_PUNISH_ENABLED` | `false` | Enables review-bypass auto-punishment for newly initialized guilds. |
| `HONEYBOT_DEFAULT_PUNISHMENT_DM_NOTIFY` | `true` | Requires a confirmed punishment DM before applying non-log actions. |
| `HONEYBOT_DEFAULT_RETENTION_CASE_DAYS` | `180` | Case/evidence retention duration in days. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_GUILD` | `10000` | Maximum cached cross-channel detector entries per guild. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_MAX_ENTRIES_PER_USER` | `200` | Maximum cached cross-channel detector entries per user. |
| `HONEYBOT_DEFAULT_GLOBAL_BANS_ENABLED` | `false` | Opts newly initialized guilds into global-ban enforcement. |

### Policy defaults for new guilds

Actions:

- Prevention actions: `log`, `timeout`, `role`, `kick`, `ban`
- Punishment actions: `timeout`, `role`, `kick`, `ban`
- Durations are seconds; use `null` or `none` for no duration.

| Variable | Default if omitted | What it does |
| --- | --- | --- |
| `HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ACTION` | `timeout` | Immediate prevention action after a honeypot trigger. |
| `HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DURATION_SECONDS` | `21600` | Duration for honeypot timeout/temporary role actions. |
| `HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_ROLE_ID` | unset | Role ID used when honeypot prevention action is `role`. |
| `HONEYBOT_DEFAULT_HONEYPOT_PREVENTION_DELETE_MESSAGES` | `true` | Deletes trigger messages after honeypot prevention. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ACTION` | `timeout` | Immediate prevention action after a cross-channel trigger. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DURATION_SECONDS` | `1800` | Duration for cross-channel timeout/temporary role actions. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_ROLE_ID` | unset | Role ID used when cross-channel prevention action is `role`. |
| `HONEYBOT_DEFAULT_CROSSCHANNEL_PREVENTION_DELETE_MESSAGES` | `true` | Deletes duplicate trigger messages after cross-channel prevention. |
| `HONEYBOT_DEFAULT_PUNISHMENT_ACTION` | `ban` | Final punishment action after moderator approval or review-bypass. |
| `HONEYBOT_DEFAULT_PUNISHMENT_DURATION_SECONDS` | `null` | Duration for final timeout/temporary role punishments. |
| `HONEYBOT_DEFAULT_PUNISHMENT_ROLE_ID` | unset | Role ID used when final punishment action is `role`. |
| `HONEYBOT_DEFAULT_PUNISHMENT_DELETE_MESSAGES` | `true` | Deletes retained case messages when final punishment runs. |

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

## Releases and changelogs

Pull requests with user-visible changes should include a changeset:

```bash
pnpm changeset
```

Select `honeybot`, choose a patch, minor, or major bump, and describe the change for users. Commit the generated `.changeset/*.md` file with the pull request.

After the pull request merges, the release workflow creates or updates a version pull request. Merging that pull request bumps `package.json`, updates `CHANGELOG.md`, and triggers container publishing with the new version.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — product and architecture notes
- [`docs/PLAN.md`](docs/PLAN.md) — implementation plan and schema notes
- [`PRIVACY.md`](PRIVACY.md) — privacy policy
- [`TERMS.md`](TERMS.md) — terms of service
