---
'honeybot': patch
---

Harden case operation recovery and attachment ingestion so interrupted moderation remains explicitly reconcilable in Discord, unresolved cases keep accumulating evidence instead of splitting, transient member lookups cannot hide reviewable cases or block user-ID actions, unapplied actions stay retryable, and unsafe or excess evidence cannot bypass processing limits.
