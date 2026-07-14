# Honeybot Spec

Honeybot is a Discord moderation bot for public-server scam/spam raids. It focuses on users who post in honeypot channels or spam the same/similar content across channels, then uses cheap evidence checks, known scam corpus retrieval, and classifier models to decide whether the server's configured policy should run.

Implementation details and schema draft live in [`PLAN.md`](PLAN.md).

## Scope

Honeybot detects only after one of two triggers:

- `honeypot`: a user posts in a configured honeypot channel.
- `crosschannel`: a user posts repeated/similar content across multiple channels inside a configured window.

Known-corpus matching and classifier calls happen only after a trigger. This avoids scanning every normal message with expensive models.

Crosschannel similarity is cheap pre-trigger matching only: normalized text hashes, URL/domain hashes, attachment byte hashes, image perceptual hashes, and optional text shingle/MinHash fingerprints. Embeddings/classifiers do not run until after the trigger fires. Detector state is in-memory for MVP, TTL-bounded by the crosschannel window, and lost on restart.

## Abuse model

Expected abuse is mostly public-server spam/raid behavior:

- spammed images with little or no text
- Discord invite spam
- suspicious website promotion
- crypto payout/token/wallet-drainer lures
- token-stealer or wallet-stealer campaigns
- occasional impersonation

Prompts, corpus descriptions, and examples should not assume tidy targeted phishing.

## Moderation policy

The model never chooses actions. It only returns scam/spam likelihood, confidence, and a short reason.

Bot code compares exact/fuzzy matches, embedding retrieval, classifier output, and manual review against guild thresholds. Evidence only informs probability; evidence never chooses actions. Case confidence is the highest normalized confidence among evidence items, not a weighted sum, to avoid double-counting correlated signals.

Each guild has one punishment policy. If `review:bypass_enabled` is false, cases go to human review before punishment. If bypass is enabled and evidence crosses thresholds, Honeybot applies the configured punishment:

- `timeout`
- `role`
- `kick`
- `ban`

Separate prevention policies may run immediately after the trigger if configured: `honeypot_prevention` and `crosschannel_prevention`. Prevention is not evidence; it is logged as a bot action. Prevention actions may be `log`, `timeout`, `role`, `kick`, or `ban` for servers that want naive "trigger means punish" behavior. Punishment actions do not include `log`; they are `timeout`, `role`, `kick`, or `ban`. Message deletion is always a separate boolean on the policy.

Fresh guild defaults:

- Honeypot prevention: timeout for 6 hours and delete messages.
- Crosschannel prevention: timeout for 30 minutes and delete messages.
- Punishment: ban and delete messages.
- Punishment DM notification: enabled.
- Review bypass: disabled.
- Evidence confidence threshold: `0.90`.
- Case metadata retention: 180 days.

Case statuses:

- stable review states: `pending_review`, `punished`, `dismissed`
- claimed operation states: `punishment_pending`, `dismissal_pending`, `punishment_revert_pending`, `dismissal_revert_pending`
- reconciliation states: `punishment_uncertain`, `dismissal_uncertain`, `punishment_revert_uncertain`, `dismissal_revert_uncertain`

When a case is dismissed or reverted, Honeybot deletes the case row, case messages, case attachments, temporary files, case evidence rows, and pending corpus rows copied from that case. Append-only audit events remain.

Punished cases retain raw evidence indefinitely by default for audit and corpus work. `retention:case_days` defaults to 180 days for non-dismissed case metadata/review lifecycle compaction, without deleting raw punished-case evidence by default.

If `punishment:dm_notify` is true, Honeybot DMs users only after case evidence has been collected, an automatic or moderator punishment decision has been made, and that punishment has been confirmed as applied. Prevention actions do not send punishment DMs. Moderator punishment remains disabled and is rejected server-side until analysis is recorded. The DM includes the server name, decision/action, configured reason, concise evidence reason, triggering message content when available, and relevant evidence attachments as real Discord file attachments loaded from Honeybot's stored files. It must not send bot-hosted/CDN evidence links. DM failure or attachment-size limits do not block punishment; Honeybot records notification success/failure and omitted attachments in the audit trail. There is no local appeal workflow in MVP.

`reverted` means best-effort undo: remove active timeouts, remove punishment roles, and unban banned users. Kicks and deleted Discord messages cannot be undone, so Honeybot records them as irreversible in the audit trail. Revert applies to both prevention and punishment actions.

Case operations are retryable only while failure is known to precede a Discord mutation. Honeybot durably records the dispatch boundary immediately before calling Discord: startup restores interrupted, undispatched claims to their prior stable state, while interrupted dispatched operations enter their operation-specific reconciliation state. A failed Discord response or post-dispatch local persistence failure also requires reconciliation. Moderators must verify Discord's actual user state and explicitly reconcile the case; Honeybot never automatically replays an ambiguous side effect.

If a prevention policy action is `kick` or `ban`, Honeybot skips paid embeddings/classifier analysis by default. It preserves available evidence, posts/updates the moderation-channel case, and lets moderators audit/revert if needed.

## Evidence ladder

For a triggered case:

1. Record exact match evidence:
   - normalized text hash against known text entries
   - attachment byte hash against known image entries
2. Record fuzzy match evidence:
   - text shingle/MinHash match, if available
   - image perceptual hash match
3. If no exact/fuzzy match is decisive, embed text/images.
4. Retrieve nearby known scam entries by embedding proximity.
5. Rerank retrieved entries using similarity and stored descriptions/reasons.
6. Build an evidence summary:
   - exact match true/false
   - fuzzy match true/false
   - nearest known examples
   - similarity scores
   - explicit note when retrieval is weak and the case may be novel
7. Classify with message/attachments/evidence summary in context.
8. Apply bot policy from confidence thresholds and configured actions.

Cost rule: run cheap exact checks before paid embeddings/classifier calls. Text and image lanes can run in parallel once needed.

Case confidence is the highest normalized confidence among evidence items, not a weighted sum. Exact approved corpus matches score `1.00`; fuzzy, perceptual-hash, embedding, and classifier evidence use normalized scores documented in the implementation plan.

Raid cost rule: each sender gets their own case, even if multiple users send identical content. New messages from the same sender attach to that sender's unresolved case until it is dismissed/reverted/punished. If prevention is only `log`, repeated messages keep attaching to the same unresolved case. Every triggered message analysis recomputes embeddings and classifier responses, even when text/image fingerprints match earlier messages, so moderator evidence reflects the current message and current model/corpus state. Model calls and Discord moderation actions are protected by deployment-global and per-guild rolling-window rate limits.

Model/action queues are guild-fair: jobs are partitioned by guild and scheduled round-robin across non-empty guild queues before checking per-guild and global limiters. One raided guild should not monopolize capacity while other guilds have pending work. If a guild limiter is exhausted, that guild's jobs wait or fail that guild's cases to moderator review after retry/deadline policy; if the deployment-global limiter is exhausted, all affected jobs wait or fail to review.

Classifier/embedding failures also fail to moderator review. Provider calls use a pinned Effect v4 beta queue/outbox, behind Honeybot's own queue interface, with rolling-window limits, exponential backoff retries for transient errors, 429/5xx, timeouts, and malformed structured output. Auth/config errors and exhausted model-call limiters fail immediately to review.

Default hosted embeddings use OpenRouter `nvidia/llama-nemotron-embed-vl-1b-v2:free` for text and images, with the model's fixed `2048` dimensions. If OpenRouter privacy/routing blocks that model, operators should pick a production-allowed deployment-wide embedding model and rebuild the corpus so stored vectors match runtime vectors. Primary classifier defaults use paid Gemma 4, with free Gemma/Nemotron/Poolside/Tencent models as advisory signals.

## Known corpus

Known scam/spam corpus entries should store structured descriptions, not just hashes. Corpus rows own their copied text/image data and embedding vectors; they do not share case message/attachment storage.

Corpus rows include:

- what the text/image depicts or does
- why it is considered scam/spam evidence
- source case and original Discord message/attachment IDs
- approving moderator
- scope: `guild` or `global`
- guild ID for guild-scoped rows
- embedding provider/model/dimensions/vector
- status: `pending`, `approved`, or `disabled`

Pending rows are created for review candidates. Guild moderators can approve guild-scoped rows for their own server. Global promotion requires global authority. Approval changes rows to `approved`; dismiss/revert deletes pending rows.

Examples:

```txt
description = "spams Discord invite link"
scam_reason = "invite was used in prior raid spam"
```

```txt
description = "image depicts crypto payout promotion"
scam_reason = "matches known wallet-drainer campaign"
```

## Data/storage direction

Defaults for simple hosting:

- SQLite + Drizzle
- filesystem evidence/image storage under `data/images`
- `data/` mounted as a persistent Docker/Railway volume

Keep DB/storage behind adapters so Postgres and S3/R2/MinIO can come later.

## Model/provider direction

Model purposes:

- `text_classifier`
- `image_classifier`
- `text_embeddings`
- `image_embeddings`

Classifier model IDs can be configured per guild. Per-guild BYOK is supported in MVP as an override; env-level keys are the fallback, and missing keys fail model calls to moderator review.

Embedding model IDs are deployment-controlled, not per-guild, because changing embedding models/dimensions requires re-embedding the corpus. Self-hosters can choose a different deployment-wide embedding model before building their corpus, but Honeybot does not support different embedding models per guild. Guilds can bring their own embedding API key only for the deployment-selected embedding provider/model; arbitrary embedding model IDs are only allowed for deployment-level custom/self-hosted configuration.

Default hosted embeddings target: OpenRouter `nvidia/llama-nemotron-embed-vl-1b-v2:free`, which returns fixed-size `2048` vectors and should be used for both text and images so retrieval compares compatible vectors. If privacy/routing blocks it or eval quality is poor, choose another deployment-wide multimodal embedding option before seeding/rebuilding the corpus.

API keys are stored per model purpose, encrypted with `API_KEY_ENCRYPTION_KEY`, and never displayed plaintext in Discord. `/model set` has an optional `enter_api_key` boolean; when true, Honeybot opens a modal for secret entry. This keeps normal `/model set` responses safe to post publicly while avoiding a modal every time. `/model keys` shows only redacted hints.

## Global bans

Global bans are users only. Publishing is manual-only from case review components; punished cases do not auto-publish. Global ban appeals are out-of-band/operator-managed for MVP; Honeybot can track `appealed` status but does not provide an in-bot appeal flow.

Global ban publishing and global corpus promotion are controlled by env config:

- `GLOBAL_AUTH_MODE=team`: verify accepted Discord Developer Team membership with `GET /oauth2/applications/@me`, checking `team.id` against `GLOBAL_AUTH_TEAM_ID`. All accepted team members count, regardless of team role.
- `GLOBAL_AUTH_MODE=users`: verify the interaction user ID against `GLOBAL_AUTH_USER_IDS`, a comma-separated allowlist.

Global bans are checked on future member joins and swept across opted-in guilds when a new global ban is published.

## Slash commands

Slash commands only. No text commands.

Authorization:

- Server owner, `Manage Guild`, and `Administrator` can manage Honeybot by default.
- Users/roles added through `/moderators` can manage Honeybot and are exempt from moderation triggers.
- Globally authorized Honeybot operators can manage Honeybot on any server for debugging/support.
- Global operator authorization uses `GLOBAL_AUTH_MODE=team|users` with `GLOBAL_AUTH_TEAM_ID` or `GLOBAL_AUTH_USER_IDS`.

Bypass/exemption:

- Always ignore the bot's own messages, bot users, webhooks, DMs, and non-guild messages.
- Exempt server owner, `Manage Guild`, `Administrator`, and users/roles in `moderators`.
- No separate bypass list for MVP; `moderators` doubles as the explicit bypass list.

Planned command groups:

```txt
/settings
/honeypot
/moderators
/policies
/model
/global-bans
```

`/settings` opens a paginated message-components v2 UI, similar in spirit to .fmbot: dropdowns/buttons/modals for typed settings. The DB stays key/value, but the UI schema is well-defined and validates every exposed setting.

`/model`, singular, owns model/provider/API-key configuration.

Case review is not a slash command. Each case is posted to the configured moderation channel with Discord message components for approve/dismiss/punish/revert and evidence approval/rejection. Reattached review images should be spoiler-wrapped by default.
