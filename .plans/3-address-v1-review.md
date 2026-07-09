# #3 Address repo-wide v1 review findings

## Summary

Make moderator case decisions idempotent, bound untrusted attachment and image
processing, and correct the adjacent punishment-notification behavior found in a
fresh review.

## Acceptance criteria

- [ ] Dismiss, punish, and revert buttons conditionally transition the expected
      case status before Discord side effects.
- [ ] Stale or concurrent case actions are no-ops with an ephemeral response.
- [ ] Attachment downloads have byte, time, per-message, and per-case limits.
- [ ] Oversized, slow, unsupported, and unsafe images remain metadata-only.
- [ ] Image decoding has explicit pixel and processing-time limits.
- [ ] DM notification failure is audited but never blocks moderation.
- [ ] Regression tests cover state races and attachment resource limits.

## TODOs

- [ ] Add conditional case transitions and use them for every review-button
      resolution/revert path, with stale and concurrent regression tests.
- [ ] Bound attachment download size, duration, and processing counts while
      retaining metadata for skipped evidence, with regression tests.
- [ ] Harden image normalization against decompression-heavy or unsupported
      inputs, with regression tests.
- [ ] Make punishment DMs best-effort and non-blocking in prevention,
      auto-punish, and moderator-review paths, with regression tests.
- [ ] Run the full typecheck, lint, and test suite and document the results.

## Notes

- Issue reviewed with `gh issue view 3 --json number,title,body,labels,state,url`.
- Fresh review found code contradicting `docs/SPEC.md:67` and
  `docs/PLAN.md:547`: failed DMs currently block moderation.
- Worktree: `.worktrees/3-address-v1-review`.
- Branch: `codex/issue-3-review-fixes` from current `main` at `a935361`.
