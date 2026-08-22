# honeybot

## 1.1.1

### Patch Changes

- [#14](https://github.com/mia-cx/honeybot/pull/14) [`69e976b`](https://github.com/mia-cx/honeybot/commit/69e976b9a2062117cf51839ec5c3b91cbefe7391) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Render cross-channel graphs with readable container fonts and use one configured minimum window for repeats with or without attachments.

## 1.1.0

### Minor Changes

- [#12](https://github.com/mia-cx/honeybot/pull/12) [`374af4f`](https://github.com/mia-cx/honeybot/commit/374af4f58eeb4827865c05e852dd4c23c1b1a3d4) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Add deterministic beta container releases from `main` and immutable stable container releases from Changesets version tags, with idempotent Docker Hub and GHCR reconciliation.

- [#9](https://github.com/mia-cx/honeybot/pull/9) [`6f5caf2`](https://github.com/mia-cx/honeybot/commit/6f5caf266babb9673795b29e0f223eab809baebf) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Use a shorter two-second cross-channel detection window for text-only duplicate messages while retaining the configurable window for messages with attachments.

### Patch Changes

- [#11](https://github.com/mia-cx/honeybot/pull/11) [`8248eb9`](https://github.com/mia-cx/honeybot/commit/8248eb9145049be34950572d264d2bbe33afc821) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Send moderation DMs only for final punishments, and continue moderation when Discord cannot deliver the notification.

- [#4](https://github.com/mia-cx/honeybot/pull/4) [`d6e739f`](https://github.com/mia-cx/honeybot/commit/d6e739f302e6ff4fd1b3e9f5c4f353ad1e389fd8) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Harden case operation recovery and attachment ingestion so interrupted moderation remains explicitly reconcilable in Discord, unresolved cases keep accumulating evidence instead of splitting, transient member lookups cannot hide reviewable cases or block user-ID actions, unapplied actions and globally backlogged evidence stay retryable, and unsafe or excess evidence cannot bypass processing limits.
