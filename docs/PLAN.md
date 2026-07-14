# Honeybot Plan

## Goal

Build a Discord slash-command bot that catches scam behavior from two triggers:

1. `honeypot`: user posts in a configured honeypot channel.
2. `crosschannel`: user posts the same/similar message in multiple channels inside a threshold window.

After a trigger, the bot saves evidence, checks known scam text/images, optionally runs a multimodal classifier, then applies the guild's configured policy.

Primary abuse pattern is public-server raid spam: repeated images/messages advertising Discord invites, suspicious websites, crypto payouts, wallet drainers, token stealers, or impersonation. The model/corpus should not assume neat targeted phishing structure.

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
      globalBans.ts
    components/
      caseReview.ts
      evidenceReview.ts
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
  queues/
    workQueue.ts                  # Honeybot queue interface hiding Effect internals
    effectWorkQueue.ts            # Effect v4 beta implementation
    rateLimits.ts
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
moderation:channel_id
crosschannel:enabled
crosschannel:window_seconds
crosschannel:channel_threshold
known_image:similarity_threshold
known_text:similarity_threshold
evidence:confidence_threshold
review:bypass_enabled
punishment:dm_notify
retention:case_days
crosschannel:max_entries_per_guild
crosschannel:max_entries_per_user
```

```txt
policies
  guild_id
  scope               # honeypot_prevention | crosschannel_prevention | punishment
  action_type         # prevention: log | timeout | role | kick | ban; punishment: timeout | role | kick | ban
  duration_seconds
  role_id
  delete_messages     # separate bool; can be true for prevention or punishment
  created_at
  updated_at
  primary key (guild_id, scope)
```

Fresh guild defaults:

| Scope/key                                  | Default             |
| ------------------------------------------ | ------------------- |
| `honeypot_prevention.action_type`          | `timeout`           |
| `honeypot_prevention.duration_seconds`     | `21600` (6 hours)   |
| `honeypot_prevention.delete_messages`      | `true`              |
| `crosschannel_prevention.action_type`      | `timeout`           |
| `crosschannel_prevention.duration_seconds` | `1800` (30 minutes) |
| `crosschannel_prevention.delete_messages`  | `true`              |
| `punishment.action_type`                   | `ban`               |
| `punishment.delete_messages`               | `true`              |
| `punishment:dm_notify`                     | `true`              |
| `review:bypass_enabled`                    | `false`             |
| `evidence:confidence_threshold`            | `0.90`              |
| `retention:case_days`                      | `180`               |

```txt
moderators
  guild_id
  type                # user | role
  id
  created_at
  primary key (guild_id, type, id)

Users/roles in `moderators` can manage Honeybot and are exempt from moderation triggers. A compromised moderator account is outside Honeybot's automated enforcement model and should be handled by server staff.
```

```txt
honeypots
  guild_id
  channel_id
  created_at
  primary key (guild_id, channel_id)
```

```txt
models
  guild_id
  purpose            # text_classifier | image_classifier | text_embeddings | image_embeddings
  provider           # openrouter | anthropic | openai | opencode | custom
  model_id
  encrypted_api_key  # nullable; env fallback when unset
  api_key_hint       # nullable; redacted first 4 + last 4 chars, or provider label for UI only
  api_key_nonce      # nullable; random per encrypted key
  api_key_auth_tag   # nullable; AES-GCM tag
  created_at
  updated_at
  primary key (guild_id, purpose)
```

Each guild can route classifier purposes to a different provider/model/key. Per-guild BYOK is supported in MVP as an override. Missing `models` rows fall back to deployment env defaults, e.g. `DEFAULT_TEXT_CLASSIFIER_PROVIDER`, `DEFAULT_TEXT_CLASSIFIER_MODEL`, `DEFAULT_IMAGE_CLASSIFIER_PROVIDER`, `DEFAULT_IMAGE_CLASSIFIER_MODEL`, `DEFAULT_TEXT_EMBEDDINGS_PROVIDER`, `DEFAULT_TEXT_EMBEDDINGS_MODEL`, `DEFAULT_IMAGE_EMBEDDINGS_PROVIDER`, `DEFAULT_IMAGE_EMBEDDINGS_MODEL`.

Embedding model IDs are deployment-controlled, not per-guild, because model choice defines vector dimensions and changing it requires re-embedding the corpus. Self-hosters can choose a different deployment-wide embedding model before building their corpus, but Honeybot does not support different embedding models per guild. Guilds can bring their own embedding API key only for the deployment-selected embedding provider/model; arbitrary embedding model IDs are only allowed for deployment-level `custom`/self-hosted configuration. Default hosted embedding target: OpenRouter `nvidia/llama-nemotron-embed-vl-1b-v2:free`, using its fixed `2048`-dimension vectors for both text and images. If OpenRouter privacy/routing blocks it, pick a production-allowed deployment-wide embedding model before seeding or rebuilding the corpus.

BYOK values in `models.encrypted_api_key` are encrypted at rest with `API_KEY_ENCRYPTION_KEY`, never logged, and only decrypted at the provider boundary. Deployment-level API keys may be supplied by env vars as fallback defaults. If both per-guild BYOK and env fallback keys are missing, model calls fail to moderator review. Use AES-256-GCM with a random nonce per stored key; no salt/pepper scheme. The encryption key lives outside the DB in environment/config, so losing it makes stored BYOK keys unrecoverable.

API keys are never displayed in plaintext in Discord. Model/key listing only shows a redacted first-4-plus-last-4 hint like `sk_1****************abcd` so the key owner can identify which key is configured for each purpose.

### Cases/evidence

```txt
cases
  id
  guild_id
  user_id
  trigger_type        # honeypot | crosschannel
  status              # stable review state, claimed operation state, or operation-specific uncertain state
  action_taken        # last confirmed applied action; nullable for review/dismiss/revert
  operation_action_taken # action a claimed/uncertain operation may have applied
  operation_dispatched_at # durable Discord mutation boundary for restart recovery
  reason              # latest templated bot reason
  evidence_summary_json
  review_channel_id
  review_message_id
  created_at
  updated_at
```

Unresolved-case uniqueness: one active case per `guild_id + user_id + trigger_type`. New messages from the same user/trigger attach to the existing unresolved case until it is resolved. A dismissed/reverted/punished case is resolved; a later message opens a new case. Different authors always get separate cases, even if they send identical text/attachments.

```txt
case_messages
  id
  case_id
  message_id
  channel_id
  author_id
  content
  normalized_content
  text_hash
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
  review_attachment_url
  content_type
  size_bytes
  sha256
  perceptual_hash
  storage_key
  processing_slot     # bounded image-processing admission slot; null for metadata-only attachments
  processing_state    # pending | stored | failed | skipped
  created_at
```

```txt
case_evidence
  id
  case_id
  evidence_type       # exact_match | fuzzy_match | embedding_retrieval | classifier | manual_review
  matched             # true | false
  score
  summary
  metadata_json
  created_at
```

```txt
case_events
  id
  case_id             # stored as audit reference; no hard FK if cases may be deleted
  event_type          # lifecycle, moderation outcome, notification, operation failure/uncertainty/reconciliation, or retention event
  actor_type          # bot | user
  actor_id
  reason
  metadata_json
  created_at
```

### Text/images/global bans

```txt
evidence_reviews
  id
  target_type         # text | image
  target_id           # known_texts.id or known_images.id with status=pending
  status              # pending | approved | rejected
  reviewer_id
  note
  reviewed_at
  created_at
```

```txt
known_texts
  id
  normalized_text
  text_hash
  embedding_provider
  embedding_model
  embedding_dimensions
  embedding_vector_json # SQLite MVP; pgvector later if Postgres
  description           # what the message is doing, e.g. "spams invite link"
  scam_reason           # why it is treated as scam/spam evidence
  source_case_id
  source_discord_message_id
  approved_by
  scope                 # guild | global
  guild_id              # nullable for global rows
  status                # pending | approved | disabled
  created_at
  updated_at
```

```txt
known_images
  id
  sha256
  perceptual_hash
  storage_key           # corpus-owned file copy, not case attachment file
  embedding_provider
  embedding_model
  embedding_dimensions
  embedding_vector_json # SQLite MVP; pgvector later if Postgres
  description           # what the image depicts, e.g. "crypto payout promo"
  scam_reason           # why it is treated as scam/spam evidence
  source_case_id
  source_discord_attachment_id
  approved_by
  scope                 # guild | global
  guild_id              # nullable for global rows
  status                # pending | approved | disabled
  created_at
  updated_at
```

```txt
global_bans
  id
  user_id
  source_case_id
  published_by_user_id # must pass global authority check
  status              # active | removed | appealed
  reason
  created_at
  updated_at
```

## Pipeline

### Honeypot

1. Message arrives in `messageCreate`.
2. If channel is in `honeypots`, cancel/skip crosschannel detection for this message because honeypot is the stronger trigger.
3. Create `case` with `trigger_type = honeypot`.
4. Cache message + attachments.
5. Preserve original attachments in storage and reattach/link them in the moderation-channel case post so reviewers can inspect the actual images.
6. Apply the guild `honeypot_prevention` policy if present.
7. Analyze case with the evidence ladder below.
8. If `review:bypass_enabled` is true and evidence crosses thresholds, apply the guild punishment policy. Otherwise post/keep the case for moderator review.
9. Write `case_events` for every step.

### Evidence ladder

1. Record exact match evidence:
   - normalized text hash against `known_texts.text_hash`
   - attachment byte hash against `known_images.sha256`
2. Record fuzzy match evidence:
   - text shingle/MinHash match, if available
   - image perceptual hash match
3. If no exact/fuzzy match is decisive, embed the message/image.
4. Retrieve nearest known scam entries by embedding proximity.
5. Rerank retrieved entries with stricter similarity checks and stored `description`/`scam_reason`.
6. Produce an evidence summary visible to moderators:
   - exact match true/false for text and image
   - fuzzy match true/false for text and image
   - nearest known examples
   - similarity scores
   - explicit note when retrieval is weak, e.g. `embedding retrieval did not find close known scams; this may still be a novel scam`
7. Classify with the message, attachments, and evidence summary in context.
8. Store classifier verdict/confidence/reason as evidence; bot policy decides review vs punishment from `evidence:confidence_threshold`.

Case confidence is the highest normalized confidence among evidence items, not a weighted sum, to avoid double-counting correlated signals. Tie priority: manual review > exact corpus match > fuzzy match > embedding rerank > classifier.

Evidence confidence normalization:

| Evidence type                       | Score                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Manual moderator scam decision      | `1.00`                                                                                                                   |
| Exact approved text hash match      | `1.00`                                                                                                                   |
| Exact approved image `sha256` match | `1.00`                                                                                                                   |
| Text MinHash/Jaccard fuzzy match    | Jaccard overlap, only counted above `known_text:similarity_threshold`                                                    |
| Image perceptual hash match         | Normalize from Hamming distance: `1 - (distance / hash_bits)`, only counted above `known_image:similarity_threshold`     |
| Embedding retrieval/rerank          | Normalized cosine similarity from reranked nearest approved corpus entry                                                 |
| Classifier                          | Provider result mapped to `confidence * scam_likelihood` when both are present, otherwise the single returned confidence |
| Weak/no retrieval                   | No score boost; not exonerating                                                                                          |

`evidence:confidence_threshold` compares against the final case confidence.

### Latency/cost plan

Run independent evidence lanes in parallel, but short-circuit expensive work when cheap exact matches are decisive.

Parallel before analysis:

- create case row
- cache message rows
- normalize text and compute text hashes
- download attachments
- store attachment files
- compute image byte hashes
- compute perceptual hashes

Parallel evidence checks:

- exact text hash lookup
- exact image `sha256` lookup
- perceptual hash candidate lookup

If exact/fuzzy evidence is decisive, skip embeddings and classifier. Otherwise run text/image embedding lanes in parallel:

- embed text and images
- retrieve nearest known text/image entries
- rerank candidates
- build one evidence summary
- make one classifier call

Default optimization is cost-first, not absolute latency: do not start paid embeddings/classifier calls until exact hash checks fail.

### Classifier/embedding failure mode

Model provider calls use an Effect v4 beta queue/outbox for typed retries, timeouts, structured failure handling, and rolling-window rate limiting.

Retry policy:

- Exponential backoff with jitter.
- Configured by `MODEL_RETRY_MAX_ATTEMPTS`, `MODEL_RETRY_INITIAL_DELAY_MS`, and `MODEL_RETRY_MAX_DELAY_MS`.
- Retry transient network errors, provider 429/5xx, timeouts, and malformed/invalid structured output.
- Do not retry permanent auth/config errors; fail immediately to review.
- If the env rolling-window model limiter is exhausted, do not retry; fail to review.

Failure result:

- Keep/create the case as `pending_review`.
- Set case reason to `model provider unavailable; sent for moderator review` or a similarly templated reason.
- Write `case_evidence` with `evidence_type = classifier`, `matched = false`, `score = null`, and error metadata.
- Write `case_events` with `event_type = failed` and provider/retry metadata.

### Crosschannel

Crosschannel uses exact + cheap fuzzy pre-trigger detection. It does not run embeddings or classifiers before a trigger.

Cheap fingerprints:

- normalized text hash
- URL/domain hash, when links are present
- attachment byte hash, after download
- image perceptual hash, for near-identical image spam
- optional text shingle/MinHash fingerprint for near-duplicate text

Detector state is in-memory for MVP, bounded by `crosschannel:window_seconds`, `crosschannel:max_entries_per_guild`, and `crosschannel:max_entries_per_user`. Restarting the bot drops detector state.

Flow:

1. Message arrives in `messageCreate`.
2. If the message already triggered honeypot, stop; honeypot owns the case.
3. If crosschannel enabled, compute cheap fingerprints.
4. Record fingerprints in the in-memory detector.
5. If enough distinct channels match within the configured window, find or create the user's unresolved `crosschannel` case.
6. Attach all matching messages to that case.
7. Cache messages/attachments and preserve attachments for the moderation-channel case post.
8. Apply the guild `crosschannel_prevention` policy if present.
9. Analyze case.
10. If `review:bypass_enabled` is true and evidence crosses thresholds, apply the guild punishment policy. Otherwise post/keep the case for moderator review.
11. Write `case_events` for every step.

### Raid economics and rate limits

Raid economics are handled without a raid/group table in MVP:

- Each sender gets their own case, even when content is identical across users.
- New messages from the same sender attach to their existing unresolved case instead of creating more cases.
- Prevention policies usually stop repeated offenses. If prevention is only `log`, messages continue attaching to the same unresolved case until it is dismissed/reverted/punished.
- Model/provider calls go through an Effect v4 beta queue/outbox that enforces deployment-global and per-guild rolling-window limits for polite OpenRouter/provider use.
- Discord moderation actions also go through an Effect-managed queue/outbox with deployment-global and per-guild rolling-window limits so punishment bursts do not fight API limits.
- Queues are guild-fair: jobs are partitioned by `guild_id` and scheduled round-robin across non-empty guild queues before checking per-guild and global limiters. One raided guild should not monopolize model or moderation action capacity while other guilds have pending work.
- If a per-guild limiter is exhausted, that guild's jobs wait for the next window or fail that guild's cases to moderator review after the configured retry/deadline policy. If the deployment-global limiter is exhausted, all affected jobs wait or fail to review according to the same policy.
- Evidence-ladder results are recomputed for every triggered message, even when exact/fuzzy content fingerprints (`text_hash`, image `sha256`, pHash/MinHash signatures) match earlier messages. Different senders still get separate cases, and repeated content still gets fresh embeddings/classifier responses so evidence reflects current model/corpus state.

Env-level limits:

```txt
MODEL_CALL_LIMIT
MODEL_CALL_LIMIT_PER_GUILD
MODEL_CALL_WINDOW_SECONDS
MODEL_RETRY_MAX_ATTEMPTS
MODEL_RETRY_INITIAL_DELAY_MS
MODEL_RETRY_MAX_DELAY_MS
MODERATION_ACTION_LIMIT
MODERATION_ACTION_LIMIT_PER_GUILD
MODERATION_ACTION_WINDOW_SECONDS
GLOBAL_AUTH_MODE
GLOBAL_AUTH_TEAM_ID
GLOBAL_AUTH_USER_IDS
```

### Case cleanup, retention, and revert semantics

Retention is both a storage and trust policy.

Retention rules:

- Dismissed/reverted cases are deleted after writing final audit events: delete the `cases` row, case messages, case attachments, stored temporary files, case evidence rows, and pending corpus rows copied from that case. Keep append-only `case_events` audit records.
- Punished cases retain raw evidence messages, attachment metadata, stored attachment files, hashes, embeddings, and evidence summaries indefinitely by default for audit and corpus work.
- `retention:case_days` defaults to `180` days for non-dismissed case metadata/review lifecycle compaction. Do not delete raw punished-case evidence by default.
- Audit/event rows must retain enough original Discord IDs, actor IDs, and reason metadata to remain useful after dismissed/reverted case rows are deleted.
- Approved corpus rows remain until disabled or removed.

Corpus promotion is copy-on-promote: known text/image rows own their normalized text, copied image file, and embedding vector. They never share case message/attachment storage. Guild moderators can approve guild-scoped corpus rows for their own server. Global corpus promotion requires global authority. Pending corpus rows become `approved` when an authorized reviewer approves them; dismiss/revert deletes pending rows instead of leaving rejected corpus entries.

`reverted` means best-effort undo for reversible bot actions:

- `timeout`: remove timeout if still active.
- `role`: remove the configured punishment role.
- `kick`: cannot undo; record as irreversible in `case_events`.
- `ban`: unban the user.
- `delete_messages`: cannot undo Discord deletion; record as irreversible in `case_events`.

Revert applies to both prevention and punishment actions. If prevention already timed out/role/kicked/banned a user, dismiss/revert attempts the same best-effort undo. Every revert attempt writes a `case_events` row with success/failure and irreversible-action metadata.

If a prevention policy action is `kick` or `ban`, skip paid embeddings/classifier analysis by default. Preserve available evidence, post/update the moderation-channel case, and let moderators audit/revert if needed.

### Punished user notifications

If `punishment:dm_notify` is true, Honeybot attempts to DM the user after evidence collection and an automatic or moderator punishment decision, but before applying that punishment. Prevention actions do not send punishment DMs. Moderator punishment controls stay disabled, with a server-side guard, until analysis is recorded. The DM includes:

- the server name
- the moderation decision/action
- the configured reason plus concise evidence reason
- the triggering message content when available
- relevant evidence attachments as actual Discord file attachments loaded from Honeybot's stored files, not links to bot-hosted/CDN evidence URLs

DM failure must not block the punishment. Record success/failure in `case_events`. If attachment files exceed Discord DM limits or are unavailable, send the text notification and record omitted attachments in `case_events`.

There is no local appeal workflow in MVP and no "copy appeal note" review button.

### Global bans

Global bans are users only.

Publishing is manual-only from case review components. No automatic global-ban publishing from punished cases. The publisher must pass the env-controlled global authority check. Global ban appeals are out-of-band/operator-managed for MVP; Honeybot can track `appealed` status but does not provide an in-bot appeal flow.

Global authority modes:

- `GLOBAL_AUTH_MODE=team`: use Discord's `GET /oauth2/applications/@me` with the bot token. The returned application object includes `team`; verify `team.id === GLOBAL_AUTH_TEAM_ID` and check `team.members` for the interaction user's ID with `membership_state = 2` (`ACCEPTED`). This grants global authority to all accepted team members regardless of team role.
- `GLOBAL_AUTH_MODE=users`: check the interaction user's ID against `GLOBAL_AUTH_USER_IDS`, a comma-separated allowlist.

If the user does not pass the configured global authority check, hide/deny global-ban publish and global-corpus promotion actions.

On member join:

1. `guildMemberAdd` fires.
2. If guild opted into consuming global bans, check `global_bans` by `user_id`.
3. Apply configured global-ban policy or notify moderators.

On global-ban publish:

1. Insert `global_bans` row with `published_by_user_id`.
2. For opted-in guilds, sweep existing members for that user ID.
3. Apply configured global-ban policy or notify moderators for matches.

## Slash commands and components

Authorization rules:

- Server owner, members with `Manage Guild`, and members with `Administrator` can manage Honeybot by default.
- Users/roles in `moderators` can manage Honeybot after being added with `/moderators` and are exempt from moderation triggers.
- Globally authorized Honeybot operators can manage Honeybot on any server for debugging/support. Use the same global authority config as global-ban/corpus publishing: `GLOBAL_AUTH_MODE=team|users`, with `GLOBAL_AUTH_TEAM_ID` or `GLOBAL_AUTH_USER_IDS`.
- All slash commands and review components must pass this authorization check unless a command is intentionally read-only/public.

Moderation trigger bypass rules:

- Always ignore the bot's own messages, bot users, webhooks, DMs, and non-guild messages.
- Exempt server owner, members with `Manage Guild`, members with `Administrator`, and users/roles in `moderators`.
- No separate bypass table for MVP; `moderators` doubles as the explicit bypass list.

Case review is handled through Discord message components. Every case gets posted to the channel configured by `moderation:channel_id` with buttons/selects for reviewer actions. There are no `/review` slash commands. Reattached review images should be spoiler-wrapped by default because raid images may be NSFW, illegal, or otherwise harmful to display unprompted.

Settings command rules:

- `/settings` opens a paginated Discord message-components v2 UI.
- Settings are edited with dropdowns, buttons, and modals as needed; no free-form `/settings set <key> <value>` command.
- The DB remains arbitrary `settings(guild_id, key, value)`, but the UI schema is explicit and typed.
- The settings UI registry defines each setting's page, label, description, type, default, validation, parser, and formatter.
- Unknown keys can exist in the DB for forward compatibility, but the UI only exposes known settings.

Model command rules:

- Use `/model`, not `/models`.
- `/model set` requires only `purpose`; `provider`, `model_id`, and `enter_api_key` are optional.
- If `enter_api_key=true`, the command opens a modal for API-key entry. If false/omitted, no modal appears.
- `/model set` responses can be public because API keys are never included in command args or response content.
- If no provider/model is already configured for a classifier purpose, `/model set` must require both `provider` and `model_id`.
- If `provider` is supplied for a classifier purpose, validate `model_id` against that provider.
- If `provider` is omitted for a classifier purpose, validate `model_id` against the purpose's existing provider.
- For embedding purposes, provider/key can be changed but model IDs are fixed by supported provider profiles unless provider is `custom`/self-hosted.
- API keys are submitted through the modal, encrypted immediately, and never echoed back in plaintext.
- `/model keys` shows only redacted key hints per purpose.

Initial commands:

```txt
/settings

/honeypot add <channel>
/honeypot remove <channel>
/honeypot list

/moderators add-user <user>
/moderators add-role <role>
/moderators remove-user <user>
/moderators remove-role <role>
/moderators list

/policies set <scope> <action> [duration] [role] [delete_messages]
/policies list

/model set <purpose> [provider] [model_id] [enter_api_key]
/model clear-key <purpose>
/model clear <purpose>
/model list
/model keys

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
- Implement dismissed/reverted cleanup for case rows, case messages, case attachments, temp files, case evidence rows, and pending corpus rows copied from the case while keeping audit events.

### Phase 4: known evidence corpus

- Download/store image attachments.
- Compute normalized text hashes and image `sha256` hashes.
- Compute perceptual image hashes.
- Add known text/image exact lookup.
- Add embedding retrieval for known text/image entries.
- Create pending `known_texts`/`known_images` rows for review candidates, with corpus-owned copies of text/image data and embeddings.
- Post cases/evidence reviews to the configured moderation channel.
- Handle approve/dismiss/punish/revert/approve-evidence/reject-evidence through Discord message components, not slash commands.

### Phase 5: classifier

- Keep classifier system prompts as plain Markdown files in `prompts/`:
  - `prompts/scam-text.md`
  - `prompts/scam-image.md`
- Load prompts as text; no componentized prompt framework unless prompt complexity actually grows.
- Add provider/model routing per purpose:
  - `text_classifier`
  - `image_classifier`
  - `text_embeddings`
  - `image_embeddings`
- Add classifier provider adapters:
  - OpenRouter for cheap/free model trials.
  - Anthropic Claude API.
  - OpenAI API.
  - OpenCode/local/custom provider path if practical.
- Use pinned `effect@4.0.0-beta.93` behind Honeybot's own queue/outbox interface for provider calls: rolling-window rate limits, exponential backoff retries, timeouts, typed errors, and fail-to-review handling. Effect internals should not leak into classifier/moderation domain modules.
- Add strict JSON prompt/contract with no `labels` field.
- Classifier only reports scam/spam likelihood, confidence, and `reason`; it never chooses moderation action.
- Reasons should be short and generic, e.g. `resembles known scam raid images`, `image depicts crypto payout`, `message promotes suspicious Discord invite`, `message points users to likely wallet drainer`.
- Bot code compares confidence against guild settings and resolves the configured policy.
- Store classifier result in case state + events.
- Default hosted embeddings target is OpenRouter `nvidia/llama-nemotron-embed-vl-1b-v2:free` for both text and image embeddings, using its fixed `2048` dimensions. First eval should verify shared text/image embedding space with controlled text↔image retrieval tests. If routing blocks it or quality is poor, choose another deployment-wide multimodal embedding option and rebuild corpus vectors.
- Classifier eval candidates, in preference order:
  1. OpenRouter free-tier Gemma 4 quant model as the cheap/default baseline; verify the current OpenRouter model slug during implementation.
  2. Paid Gemma tier if the free tier hits rate limits or quality is close but capacity is insufficient.
  3. Gemini 3.1 Flash Lite as a likely stronger/cheap classifier candidate.
  4. Gemini 3.5 Flash as the stronger fallback candidate.
  5. Another OpenRouter multimodal classifier if Gemma/Gemini quality is poor on the eval corpus.
- Add corpus eval script using `EVAL_CORPUS_DIR`; local dev can point it at private corpora such as `~/Downloads/mrscam*` without making that path canonical.
- Track eval results by model, prompt version, cost, latency, false positives, false negatives, and rate-limit behavior.

### Phase 6: global bans

- Add `global_bans` store.
- Add env-controlled global authority: `GLOBAL_AUTH_MODE=team|users`, with `GLOBAL_AUTH_TEAM_ID` or `GLOBAL_AUTH_USER_IDS`.
- For team mode, verify accepted Team membership via `GET /oauth2/applications/@me`.
- Add manual global-ban publish action to case review components, visible/usable only by globally authorized users.
- Add `guildMemberAdd` event.
- Add opt-in slash commands.
- Add join-time policy handling.
- Add sweep of opted-in guilds when a global ban is published.

### Phase 7: ops hardening

- Add Dockerfile and Railway notes.
- Add retention/compaction job for case metadata using `retention:case_days`, while keeping evidence messages/images indefinitely by default.
- Add backup/export command.
- Add audit/log embeds.
- Add tests around policy resolution and pipelines.

## Open questions

None currently.
