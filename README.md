# Honeybot

Discord.js scaffold for a honeypot moderation bot.

See [`docs/PLAN.md`](docs/PLAN.md) for the current implementation plan and schema draft.

## What is scaffolded

- Discord.js v14 TypeScript bot entrypoint.
- Per-guild JSON configuration.
- Honeypot channel detection.
- Bypass checks for users, roles, and members with `ModerateMembers`.
- Immediate timeout + message delete pipeline for honeypot messages.
- Duplicate-message threshold detection across channels.
- Cached message metadata, including attachment URLs.
- Classifier interface with a safe placeholder implementation.
- Configurable scam punishments: ban, timeout, role, delete-only, or log-only.
- Opt-in global ban list interface with a no-op implementation.

The classifier is intentionally not wired yet. The placeholder returns `needs_review`, so AI-based punishment is disabled until we choose the model and moderation policy.

## Setup

```bash
npm install
cp .env.example .env
cp config/guilds.example.json config/guilds.json
```

Fill in `.env`:

```bash
DISCORD_TOKEN=your-bot-token
CONFIG_PATH=config/guilds.json
LOG_LEVEL=info
```

Edit `config/guilds.json` with real guild, channel, role, and log channel IDs.

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
npm run dev       # run with tsx watch
npm run typecheck # type-check only
npm run build     # emit dist/
npm start         # run dist/index.js
```

## Proposed codebase shape

```text
src/
  index.ts                         # bootstrap only: config, client, registries
  discord/
    client.ts                      # client construction + intents
    events/
      messageCreate.ts             # message pipeline entrypoint only
      interactionCreate.ts         # slash command dispatcher only
      ready.ts                     # startup logging / command registration hook
    commands/
      index.ts                     # exports command registry
      honeypot.ts                  # /honeypot configure/status
      punishments.ts               # /punishment configure/show
      reviewQueue.ts               # /review next/approve/reject
      globalBanList.ts             # /global-ban opt-in/status
    commandKit/
      command.ts                   # shared SlashCommand module interface
      registerCommands.ts          # deploy guild/global slash commands
      permissions.ts               # command permission helpers
  moderation/
    pipelines/
      handleHoneypotMessage.ts
      handleDuplicateMessage.ts
      classifyAndPunish.ts
    policies/
      bypassPolicy.ts
      punishmentPolicy.ts
      duplicatePolicy.ts
    actions/
      deleteMessage.ts
      punishMember.ts
      logModerationEvent.ts
  classification/
    scamClassifier.ts              # semantic/multimodal classifier interface
    classifierPrompt.ts
    knownScamImages.ts             # exact + similarity match before AI
  reviewQueue/
    reviewQueue.ts                 # admin queue domain API
    scamImageReviewQueue.ts
  persistence/
    guildConfigStore.ts
    messageCacheStore.ts
    knownScamImageStore.ts
    globalBanListStore.ts
  config/
    env.ts
    schema.ts
  shared/
    logger.ts
    result.ts                      # only if we choose Result-style boundaries
    ids.ts
```

Slash commands should be standalone modules that export their Discord command definition plus handler. Shared behavior should live in deeper domain modules, not in the command files. Message events stay focused on detection and moderation; no text-command parsing.

## Data/storage proposal

Use Drizzle with SQLite as the default durable store so self-hosters only need a writable volume. Keep image bytes out of the relational tables by default: store evidence and known scam image files in a bot-managed filesystem directory, with SQLite rows holding hashes, file keys, status, and moderation metadata. Keep the storage behind an adapter so larger deployments can move images to S3/R2/MinIO later.

Core tables:

- `settings`: per-guild scalar settings like moderation channel, thresholds, and feature flags.
- `honeypots`: honeypot channel rows.
- `moderators`: moderator user/role rows.
- `policies`: structured action policies like review, timeout, role, kick, or ban.
- `cases`: honeypot/crosschannel incidents with current state, latest reason, and active action summary.
- `case_messages`: messages involved in a case, including normalized content and deletion state.
- `case_attachments`: attachment metadata, byte hash, perceptual hash, optional embedding id, content type, storage key, and retention status.
- `case_events`: append-only audit log for detections, classifier results, moderator decisions, and bot actions.
- `image_reviews`: admin queue for scam-classified images before they become known-bad.
- `known_images`: approved known scam images with `sha256`, perceptual hash, optional embedding vector, source case, reviewer, and storage key.
- `global_bans`: opt-in global user ban list entries only; checked on member join.

Case state:

- `trigger_type`: `honeypot` or `crosschannel` only.
- `status`: `pending_review`, `punished`, `dismissed`, or `reverted`.
- `action_taken`: latest action category, including `review`, `timeout`, `role`, `kick`, `ban`, `dismiss`, or `revert`.
- `reason`: latest templated reason, such as `classifier identified potential scam. confidence: 94%` or `image matches corpus. similarity: 98%`.
- `case_events` stores the full append-only history.

Image storage should be hidden behind an adapter interface so local disk, SQLite blobs, S3, R2, or MinIO can be swapped without touching moderation logic. Default filesystem layout:

- `data/honeybot.sqlite` for the SQLite database.
- `data/images/evidence/{guildId}/{caseId}/{attachmentId}` for temporary case evidence.
- `data/images/known-scam-images/{sha256}` for approved known-bad images.

For Docker/Railway, mount `data/` as the persistent volume. Without a volume, restarts or redeploys can lose config, moderation cases, and known scam images.

Known scam image lookup should run after a honeypot or crosschannel trigger and before the multimodal classifier:

1. Compute `sha256` for exact byte match.
2. Compute a perceptual hash for image-level similarity.
3. Optionally compute/store a high-dimensional image embedding for semantic similarity exploration and admin tooling.
4. If exact match exists, immediately apply the configured scam action.
5. If perceptual hash is within a very strict Hamming-distance threshold, immediately apply the configured scam action.
6. Otherwise, fall through to the semantic/multimodal classifier.

## Next planning topics

1. Classifier provider and prompt contract.
2. Attachment fetching/storage policy.
3. Moderator review flow and log channel embeds.
4. Global ban list consent, API shape, and appeal process.
5. Safety thresholds before destructive actions.
6. Known scam image database:
   - Images classified as scam should enter an admin review queue.
   - Approved images are stored as known scam images with byte hashes and perceptual/similarity hashes.
   - New messages with byte-identical images, or images above a very high similarity threshold, can bypass the semantic classifier and go straight to the configured scam action.
   - This should reduce multimodal token spend while keeping humans in the loop for adding new known-bad images.
