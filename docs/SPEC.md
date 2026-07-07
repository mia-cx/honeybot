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

Case statuses:

- `pending_review`
- `punished`
- `dismissed`
- `reverted`

Evidence messages, attachment metadata, and stored images are retained indefinitely by default. `retention:case_days` defaults to 180 days for case metadata/review lifecycle cleanup across all statuses. This is mainly about storage use, not treating scammer evidence as sensitive user data. Pending corpus rows copied from dismissed/reverted cases are deleted; approved corpus rows remain.

`reverted` means best-effort undo: remove active timeouts, remove punishment roles, and unban banned users. Kicks and deleted Discord messages cannot be undone, so Honeybot records them as irreversible in the audit trail.

If case rows are compacted or hard-deleted after retention, evidence rows must retain original Discord IDs and nullable source references so stored evidence does not dangle.

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

Raid cost rule: each sender gets their own case, even if multiple users send identical content. New messages from the same sender attach to that sender's unresolved case until it is dismissed/reverted/punished. If prevention is only `log`, repeated messages keep attaching to the same unresolved case. Model calls and Discord moderation actions are protected by env-level rolling-window rate limits; exhaustion fails to moderator review.

Classifier/embedding failures also fail to moderator review. Provider calls use an Effect v4 beta queue/outbox with rolling-window limits, exponential backoff retries for transient errors, 429/5xx, timeouts, and malformed structured output. Auth/config errors and exhausted model-call limiters fail immediately to review.

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

Classifier model IDs can be configured per guild. Embedding model IDs are deployment-controlled for hosted providers because changing dimensions requires re-embedding the corpus. Guilds can bring their own embedding API keys and choose supported embedding providers; arbitrary embedding model IDs are only allowed for custom/self-hosted providers.

Default hosted embeddings target: OpenRouter `google/gemini-embedding-2`, pending corpus/cost trials. OpenRouter documents it as mapping text and images into a unified vector space for cross-modal retrieval. First eval should verify text↔image retrieval with controlled examples; if it fails, choose another OpenRouter-hosted multimodal embedding option.

API keys are stored per model purpose, encrypted with `API_KEY_ENCRYPTION_KEY`, and never displayed plaintext in Discord. `/model set` has an optional `enter_api_key` boolean; when true, Honeybot opens a modal for secret entry. This keeps normal `/model set` responses safe to post publicly while avoiding a modal every time. `/model keys` shows only redacted hints.

## Global bans

Global bans are users only. Publishing is manual-only from case review components; punished cases do not auto-publish.

Global ban publishing and global corpus promotion are controlled by env config:

- `GLOBAL_AUTH_MODE=team`: verify accepted Discord Developer Team membership with `GET /oauth2/applications/@me`, checking `team.id` against `GLOBAL_AUTH_TEAM_ID`.
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

Case review is not a slash command. Each case is posted to the configured moderation channel with Discord message components for approve/dismiss/punish/revert and evidence approval/rejection.
