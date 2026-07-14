# honeybot

## 1.1.0

### Minor Changes

- [#9](https://github.com/mia-cx/honeybot/pull/9) [`6f5caf2`](https://github.com/mia-cx/honeybot/commit/6f5caf266babb9673795b29e0f223eab809baebf) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Use a shorter two-second cross-channel detection window for text-only duplicate messages while retaining the configurable window for messages with attachments.

### Patch Changes

- [#11](https://github.com/mia-cx/honeybot/pull/11) [`8248eb9`](https://github.com/mia-cx/honeybot/commit/8248eb9145049be34950572d264d2bbe33afc821) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Send moderation DMs only for final punishments, and continue moderation when Discord cannot deliver the notification.

- [#4](https://github.com/mia-cx/honeybot/pull/4) [`d6e739f`](https://github.com/mia-cx/honeybot/commit/d6e739f302e6ff4fd1b3e9f5c4f353ad1e389fd8) Thanks [@mia-riezebos](https://github.com/mia-riezebos)! - Harden case operation recovery and attachment ingestion so interrupted moderation remains explicitly reconcilable in Discord, unresolved cases keep accumulating evidence instead of splitting, transient member lookups cannot hide reviewable cases or block user-ID actions, unapplied actions and globally backlogged evidence stay retryable, and unsafe or excess evidence cannot bypass processing limits.
