# Honeybot

Honeybot is a Discord moderation bot for catching scam/spam raids with honeypot channels, cross-channel repeat detection, known scam evidence, and configurable per-server punishments.

The current codebase is an early Discord.js scaffold. Key docs:

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

## Current scaffold

Implemented now:

- Discord.js v14 TypeScript entrypoint.
- JSON config scaffold.
- Honeypot channel detection.
- Bypass checks for users, roles, and members with `ModerateMembers`.
- Immediate honeypot timeout/delete pipeline.
- Duplicate-message threshold detector.
- Message/attachment metadata cache.
- Placeholder classifier that always returns `needs_review`.
- Configurable action types: ban, timeout, role, delete-only, log-only.
- Prompt files under `prompts/` as placeholders.

Not implemented yet:

- Drizzle/SQLite persistence.
- Slash command registration/handlers.
- Known scam text/image corpus.
- Embeddings and similarity retrieval.
- Real classifier providers.
- Moderation-channel case posts with message-component review actions.
- Global user ban checks.

## Setup

```bash
pnpm install
cp .env.example .env
cp config/guilds.example.json config/guilds.json
```

Fill in `.env`:

```bash
DISCORD_TOKEN=your-bot-token
LOG_LEVEL=info
```

For the current scaffold, edit `config/guilds.json` with real guild, channel, role, and log channel IDs. This JSON config is temporary until the planned SQLite persistence layer lands.

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
```

## Hosting notes

Planned default deployment shape:

- SQLite database at `data/honeybot.sqlite`
- local image/evidence storage under `data/images/`
- `data/` mounted as a persistent Docker/Railway volume

Without a persistent volume, redeploys can lose config, cases, and known scam evidence.
