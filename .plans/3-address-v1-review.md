# #3 Address repo-wide v1 review findings

## Summary

Make moderator case decisions idempotent, bound untrusted attachment and image
processing, and correct the adjacent punishment-notification behavior found in a
fresh review.

## Acceptance criteria

- [x] Dismiss, punish, and revert buttons conditionally transition the expected
      case status before Discord side effects.
- [x] Stale or concurrent case actions are no-ops with an ephemeral response.
- [x] Attachment downloads have byte, time, per-message, and per-case limits.
- [x] Oversized, slow, unsupported, and unsafe images remain metadata-only.
- [x] Image decoding has explicit pixel and processing-time limits.
- [x] DM notification failure is audited but never blocks moderation.
- [x] Regression tests cover state races and attachment resource limits.

## TODOs

- [x] Add conditional case transitions and use them for every review-button
      resolution/revert path, with stale and concurrent regression tests.
- [x] Bound attachment download size, duration, and processing counts while
      retaining metadata for skipped evidence, with regression tests.
- [x] Harden image normalization against decompression-heavy or unsupported
      inputs, with regression tests.
- [x] Make punishment DMs best-effort and non-blocking in prevention,
      auto-punish, and moderator-review paths, with regression tests.
- [x] Run the full typecheck, lint, and test suite and document the results.

## Notes

- Issue reviewed with `gh issue view 3 --json number,title,body,labels,state,url`.
- Fresh review found code contradicting `docs/SPEC.md:67` and
  `docs/PLAN.md:547`: failed DMs currently block moderation.
- Worktree: `.worktrees/3-address-v1-review`.
- Branch: `codex/issue-3-review-fixes` from current `main` at `a935361`.
- Conditional transition validation: `../../node_modules/.bin/tsc --noEmit` and
  `../../node_modules/.bin/vitest run tests/services.test.ts` (30 tests passed).
- Attachment-limit validation: typecheck plus `tests/services.test.ts` (31 tests)
  and `tests/ui-and-integrations.test.ts` (26 tests) passed.
- Image-normalization validation: typecheck and
  `tests/ui-and-integrations.test.ts` (27 tests) passed.
- Notification/concurrency validation: typecheck and `tests/services.test.ts`
  (33 tests) passed, including concurrent moderator punishment and failed-DM
  paths.
- Final validation: TypeScript typecheck passed; ESLint passed; Vitest passed all
  89 tests across 9 files.
