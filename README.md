# Honeybot

Honeybot is a Discord moderation bot for catching scam/spam raids with honeypot channels, cross-channel repeat detection, known scam evidence, and configurable per-server punishments.

The current codebase is a TypeScript Discord.js MVP. Key docs:

- [`docs/SPEC.md`](docs/SPEC.md) — current product and architecture notes
- [`docs/PLAN.md`](docs/PLAN.md) — implementation plan and schema draft
- [`PRIVACY.md`](PRIVACY.md) — privacy policy
- [`TERMS.md`](TERMS.md) — terms of service

## How it works

Honeybot only reacts after one of two triggers:

1. **Honeypot trigger** — a user posts in a configured honeypot channel.
2. **Cross-channel trigger** — a user posts repeated/similar content across multiple channels within a configured window.

After a trigger, the intended pipeline is:

1. Create a moderation case.
2. Cache involved messages and attachments, preserving original attachment files for moderation review.
3. Run cheap evidence checks first:
   - exact normalized-text hash match
   - exact image byte hash match
   - text MinHash/fuzzy match
   - image perceptual hash match
4. If no exact/fuzzy match is decisive, embed text/images and retrieve nearby known scam entries.
5. Rerank retrieved evidence and build a short evidence summary.
6. Ask the configured text/image classifier for scam likelihood, confidence, and reason if needed.
7. Either send the case to moderator review or, when review bypass is enabled and confidence crosses threshold, apply the guild's configured punishment: timeout, role, kick, or ban.
8. If `punishment:dm_notify` is enabled, DM locally punished users with the decision, reason, and evidence attachments as uploaded files.

The model does **not** decide moderation actions. It only reports likelihood/confidence/reason. Bot policy decides what to do.

## Current implementation

Implemented now:

- Discord.js v14 TypeScript bot with slash command registration.
- Drizzle/SQLite persistence with filesystem evidence storage under `data/images`.
- Honeypot and cross-channel trigger detection.
- Moderator/bypass authorization.
- Prevention and punishment policies.
- Case/evidence persistence and moderation-channel review buttons.
- OpenRouter classifier adapter with per-guild BYOK overrides.
- Guild-fair queues with global and per-guild limiters.
- Local punishment DMs with stored evidence attachments.
- Global-ban storage, opt-in, and join-time enforcement.

Still intentionally shallow/MVP:

- Embeddings and perceptual hashes are schema-ready but not fully implemented.
- Known corpus exact hash lookup exists; approval UX is minimal.
- `/settings` is a summary response rather than the final paginated components v2 UI.

## Setup

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

Configure guilds with slash commands after the bot starts: `/honeypot`, `/moderators`, `/policies`, `/settings`, `/model`, and `/global-bans`.

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

## Scripts

```bash
pnpm dev       # run with tsx watch
pnpm typecheck # type-check only
pnpm build     # emit dist/
pnpm start     # run dist/index.js
pnpm lint      # lint source
pnpm test      # unit tests
pnpm eval:fixtures # run prompt evals against text fixtures + local EVAL_CORPUS_DIR/mrscam* images
```

## Hosting notes

Default deployment shape:

- SQLite database at `data/honeybot.sqlite`
- local image/evidence storage under `data/images/`
- `data/` mounted as a persistent Docker/Railway/Kubernetes volume

Without a persistent volume, redeploys can lose config, cases, and known scam evidence.

Build the Docker image locally:

```bash
docker build -f docker/Dockerfile -t honeybot:local .
```

GitHub Actions builds every PR and push to `main`. Pushes to `main` publish multi-arch images to GHCR as `ghcr.io/mia-cx/honeybot:main`, `:latest`, and `:sha-...`. Docker Hub publishing is enabled when these repository settings exist:

- Secret `DOCKERHUB_USERNAME`
- Secret `DOCKERHUB_TOKEN`
- Optional variable `DOCKERHUB_REPOSITORY` (defaults to `honeybot`)

Kubernetes/k3s options:

- Raw starter manifest: [`k8s/honeybot.yaml`](k8s/honeybot.yaml)
- Helm chart: [`charts/honeybot`](charts/honeybot)

Example Helm install:

```bash
helm upgrade --install honeybot ./charts/honeybot \
  --namespace honeybot --create-namespace \
  --set image.repository=ghcr.io/YOUR_ORG/honeybot \
  --set image.tag=0.1.0 \
  --set secrets.discordToken='YOUR_DISCORD_TOKEN' \
  --set secrets.openrouterApiKey='YOUR_OPENROUTER_KEY' \
  --set secrets.apiKeyEncryptionKey='BASE64_32_BYTE_KEY' \
  --set env.GLOBAL_AUTH_TEAM_ID='YOUR_DISCORD_APP_TEAM_ID'
```
