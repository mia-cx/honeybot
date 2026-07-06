# Honeybot Plan

## Goal

Build a Discord slash-command bot that catches scam behavior from two triggers:

1. `honeypot`: user posts in a configured honeypot channel.
2. `crosschannel`: user posts the same/similar message in multiple channels inside a threshold window.

After a trigger, the bot saves evidence, checks known scam images, optionally runs a multimodal classifier, then applies the guild's configured policy.

## Locked decisions

- Slash commands only. No text commands.
- SQLite + Drizzle by default.
- Filesystem image storage by default under `data/images`.
- `data/` must be a persistent Docker/Railway volume.
- Keep DB/storage behind adapters so Postgres/S3/R2 can come later.
- Table names stay short: `settings`, `policies`, `moderators`, `honeypots`, `cases`, etc.
- Triggers are only `honeypot` and `crosschannel`.
- Known-image matching and classifier checks happen only after a trigger.
- Global bans are users only and checked on member join.

## Codebase shape

```txt
src/
  index.ts
  discord/
    client.ts
    events/
      ready.ts
      messageCreate.ts
      interactionCreate.ts
      guildMemberAdd.ts
    commands/
      index.ts
      honeypot.ts
      settings.ts
      policies.ts
      moderators.ts
      review.ts
      globalBans.ts
    commandKit/
      command.ts
      registerCommands.ts
      permissions.ts
  detection/
    honeypot.ts
    crosschannel.ts
  moderation/
    pipelines/
      handleTrigger.ts
      analyzeCase.ts
      applyPolicy.ts
    actions/
      deleteMessages.ts
      punishUser.ts
      notifyModerators.ts
    policies/
      resolvePolicy.ts
      formatReason.ts
  classification/
    scamClassifier.ts
    providers/
      openRouterClassifier.ts
      anthropicClassifier.ts
      openAiClassifier.ts
      openCodeClassifier.ts
    knownImages.ts
    imageFingerprint.ts
    imageEmbedding.ts
    evals.ts
  prompts/
    loadPrompt.ts
  reviewQueue/
    cases.ts
    images.ts
  persistence/
    db.ts
    schema.ts
    migrations/
    stores/
      settingsStore.ts
      policyStore.ts
      caseStore.ts
      knownImageStore.ts
      globalBanStore.ts
  storage/
    imageStorage.ts
    filesystemImageStorage.ts
  security/
    apiKeys.ts
    encryption.ts
  config/
    env.ts
  shared/
    logger.ts
    ids.ts
```

## Schema draft

### Config

```txt
settings
  guild_id
  key
  value
  updated_at
  primary key (guild_id, key)
```

Scalar settings only:

```txt
moderation_channel_id
crosschannel_enabled
crosschannel_window_seconds
crosschannel_channel_threshold
crosschannel_prevention_delete
crosschannel_punishment_delete
known_image_similarity_threshold
classifier_confidence_threshold
classifier_provider
classifier_model
```

```txt
policies
  guild_id
  detection_type      # honeypot | crosschannel | known_image_exact | known_image_similar | classifier
  phase               # prevention | punishment
  action_type         # review | timeout | role | kick | ban
  duration_seconds
  role_id
  created_at
  updated_at
  primary key (guild_id, detection_type, phase)
```

```txt
moderators
  guild_id
  type                # user | role
  id
  created_at
  primary key (guild_id, type, id)
```

```txt
honeypots
  guild_id
  channel_id
  created_at
  primary key (guild_id, channel_id)
```

```txt
api_keys
  guild_id
  provider           # openrouter | anthropic | openai | opencode | custom
  encrypted_key
  key_hint           # last 4 chars or provider label for UI only
  created_at
  updated_at
  primary key (guild_id, provider)
```

API keys are BYOK, encrypted at rest with `API_KEY_ENCRYPTION_KEY`, never logged, and only decrypted at the provider boundary. Deployment-level API keys may be supplied by env vars as fallback defaults. Use AES-256-GCM with a random nonce per stored key; no salt/pepper scheme. The encryption key lives outside the DB in environment/config, so losing it makes stored BYOK keys unrecoverable.

### Cases/evidence

```txt
cases
  id
  guild_id
  user_id
  trigger_type        # honeypot | crosschannel
  status              # pending_review | punished | dismissed | reverted
  action_taken        # review | timeout | role | kick | ban | dismiss | revert; resolved by bot policy, not model
  reason              # latest templated bot reason
  created_at
  updated_at
```

```txt
case_messages
  id
  case_id
  message_id
  channel_id
  author_id
  content
  normalized_content
  deleted
  created_at
```

```txt
case_attachments
  id
  case_id
  case_message_id
  discord_attachment_id
  original_url
  content_type
  size_bytes
  sha256
  perceptual_hash
  embedding_id
  storage_key
  created_at
```

```txt
case_events
  id
  case_id
  event_type          # triggered | image_matched | classified | reviewed | punished | dismissed | reverted | failed
  actor_type          # bot | user
  actor_id
  reason
  metadata_json
  created_at
```

### Images/global bans

```txt
image_reviews
  id
  case_attachment_id
  status              # pending | approved | rejected
  reviewer_id
  note
  reviewed_at
  created_at
```

```txt
known_images
  id
  sha256
  perceptual_hash
  embedding_id
  storage_key
  source_case_id
  source_attachment_id
  approved_by
  status              # active | disabled
  created_at
```

```txt
image_embeddings
  id
  model
  dimensions
  vector_json         # SQLite MVP; pgvector later if Postgres
  created_at
```

```txt
global_bans
  id
  user_id
  source_case_id
  status              # active | removed | appealed
  reason
  created_at
  updated_at
```

## Pipeline

### Honeypot

1. Message arrives in `messageCreate`.
2. If channel is in `honeypots`, create `case` with `trigger_type = honeypot`.
3. Cache message + attachments.
4. Apply prevention policy for `honeypot/prevention`.
5. Analyze case:
   - exact image hash match
   - perceptual hash match
   - optional embedding similarity
   - multimodal classifier if no known-image match
6. Apply punishment policy or send to review.
7. Write `case_events` for every step.

### Crosschannel

1. Message arrives in `messageCreate`.
2. If crosschannel enabled, record normalized content in detector.
3. If threshold is hit, create one `case` with all matching messages.
4. Apply prevention policy for `crosschannel/prevention`.
5. Analyze case.
6. Apply punishment policy or send to review.
7. Write `case_events` for every step.

### Member join

1. `guildMemberAdd` fires.
2. If guild opted into consuming global bans, check `global_bans` by `user_id`.
3. Apply configured global-ban policy or notify moderators.

## Slash commands

Initial commands:

```txt
/settings set <key> <value>
/settings get [key]

/honeypot add <channel>
/honeypot remove <channel>
/honeypot list

/moderators add-user <user>
/moderators add-role <role>
/moderators remove-user <user>
/moderators remove-role <role>
/moderators list

/policies set <detection> <phase> <action> [duration] [role]
/policies list

/review next
/review approve <case>
/review dismiss <case>
/review punish <case>
/review approve-image <image_review>
/review reject-image <image_review>

/global-bans status
/global-bans opt-in
/global-bans opt-out
```

## Implementation phases

### Phase 1: persistence foundation

- Add Drizzle + SQLite.
- Add schema/migrations.
- Replace JSON config with stores for `settings`, `policies`, `moderators`, `honeypots`.
- Add filesystem image storage adapter.

### Phase 2: command framework

- Add slash command module interface.
- Add command registry and deployment script.
- Add `interactionCreate` dispatcher.
- Implement config commands for settings, policies, moderators, honeypots.

### Phase 3: case pipeline

- Add `cases`, `case_messages`, `case_attachments`, `case_events` stores.
- Refactor message listener into trigger detection only.
- Implement honeypot pipeline.
- Implement crosschannel pipeline.
- Implement prevention/punishment policy resolver.

### Phase 4: known image system

- Download/store image attachments.
- Compute `sha256`.
- Compute perceptual hash.
- Add known image lookup.
- Add `image_reviews` queue.
- Add review commands to approve/reject known scam images.

### Phase 5: classifier

- Keep classifier system prompts as plain Markdown files in `prompts/`:
  - `prompts/scam-text.md`
  - `prompts/scam-image.md`
- Load prompts as text; no componentized prompt framework unless prompt complexity actually grows.
- Add classifier provider adapters:
  - OpenRouter for cheap/free model trials.
  - Anthropic Claude API.
  - OpenAI API.
  - OpenCode/local/custom provider path if practical.
- Add strict JSON prompt/contract.
- Classifier only reports scam likelihood/confidence and rationale; it never chooses moderation action.
- Bot code compares confidence against guild settings and resolves the configured policy.
- Store classifier result in case state + events.
- Add corpus eval script using `~/Downloads/mrscam*` images for prompt/model trials.
- Track eval results by model, prompt version, cost, latency, false positives, and false negatives.

### Phase 6: global bans

- Add `global_bans` store.
- Add `guildMemberAdd` event.
- Add opt-in slash commands.
- Add join-time policy handling.

### Phase 7: ops hardening

- Add Dockerfile and Railway notes.
- Add retention cleanup job.
- Add backup/export command.
- Add audit/log embeds.
- Add tests around policy resolution and pipelines.

## Open questions

- Exact default policies for fresh guilds.
- Which OpenRouter models are good enough and cheap/free for image classification.
- Whether image embeddings are MVP or post-MVP.
- How global-ban contribution/appeals work.
- Whether known images are instance-global only or can be guild-local later.
- Whether per-server BYOK is required for MVP or env-level provider keys are enough initially.
