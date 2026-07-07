# Honeybot Privacy Policy

_Last updated: 2026-07-07_

Honeybot is a Discord moderation bot that helps servers detect scam/spam raids through honeypot channels, cross-channel repeat detection, known scam evidence, and optional AI classification.

## Data Honeybot processes

Honeybot may process:

- Discord server, channel, role, message, attachment, and user IDs.
- Server configuration, moderation policies, and moderator role/user lists.
- Messages and attachments that trigger honeypot or cross-channel detection.
- Message text, normalized text hashes, attachment byte hashes, image perceptual hashes, and embeddings.
- Moderation cases, evidence summaries, classifier results, moderator decisions, and audit events.
- Global user ban entries for servers that opt into global ban checks.
- API keys that server administrators provide for model providers.

Honeybot does not store every message by default. It stores evidence for messages that trigger moderation flows. Cross-channel detection may temporarily keep in-memory fingerprints for recent messages.

## How Honeybot uses data

Honeybot uses data to:

- Detect honeypot and cross-channel scam/spam behavior.
- Preserve evidence for moderator review.
- Compare messages and images against known scam evidence.
- Generate AI-assisted scam likelihood, confidence, and reason summaries.
- Apply server-configured moderation policies.
- Maintain audit history for moderator actions.
- Support opt-in global user ban checks.

AI models do not decide moderation actions. Server-configured policy and/or human moderators decide actions.

## AI providers and external services

Depending on configuration, Honeybot may send triggered message text, attachments, evidence summaries, or embeddings inputs to configured model providers such as OpenRouter or other supported providers.

Server-provided API keys are encrypted at rest and used only for the configured model purpose. Honeybot never intentionally displays API keys in plaintext.

## Known evidence corpus and global bans

Servers may approve known scam/spam text or image evidence for their own server. Authorized Honeybot operators may promote evidence to a global corpus.

Global bans are user IDs only. Servers must opt in before Honeybot consumes global ban data. Global ban publishing is manual-only and restricted to authorized Honeybot operators.

## Data retention

Default retention policy:

- Evidence messages, attachment metadata, stored images, hashes, and embeddings are retained indefinitely by default for audit and scam corpus use.
- Case metadata is retained for 180 days by default unless configured otherwise.
- Pending corpus rows from dismissed or reverted cases may be deleted.
- Approved corpus entries remain until disabled or removed.
- Cross-channel detector state is temporary and in-memory.
- Server settings and encrypted API keys remain until removed by an authorized administrator.

Retention is primarily intended to manage storage use, not because scammer evidence is treated as sensitive personal content.

## Access and controls

Server owners, members with appropriate Discord permissions, configured Honeybot moderators, and authorized Honeybot operators may access moderation tools according to Honeybot's authorization rules.

Server administrators can configure policies, moderators, model settings, and opt-in global features.

## Data sharing

Honeybot does not sell data.

Honeybot may share data with:

- Configured AI/model providers when needed for classification or embeddings.
- Discord, as part of normal bot operation.
- Opted-in servers, through global user ban checks or global known scam evidence.

## Security

Honeybot uses access controls for commands and review components. BYOK API keys are encrypted at rest using a deployment encryption key. No system can be guaranteed perfectly secure, but Honeybot is designed to minimize unnecessary exposure of secrets and evidence.

## Contact

For privacy requests or questions, contact the Honeybot maintainers through the project repository or the support channel provided by the bot operator.
