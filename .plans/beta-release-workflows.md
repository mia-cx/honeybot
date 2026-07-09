# Beta and stable container release workflows

## Status

Proposed implementation plan. No workflow changes have been made yet.

- Worktree: `/Users/mia/Development/mia-cx/honeybot/.worktrees/plan-beta-release-workflows`
- Branch: `plan/beta-release-workflows`
- Base: `origin/main` at `502c44e`

## Goal

Use `main` as Honeybot's integration and beta channel while treating immutable `vX.Y.Z` Git tags as production releases.

- Feature pull requests continue to target `main` and carry Changesets release intent.
- Eligible pushes to `main` automatically publish beta images to Docker Hub and GHCR.
- The beta image version is derived without committing prerelease versions to `main`.
- Changesets continues to aggregate the largest pending semantic bump in one release pull request.
- Merging the Changesets release pull request automatically creates the stable Git tag and publishes stable images to Docker Hub and GHCR.
- Pull requests verify code and workflow behavior but never publish images.

## Release model

Assume `v1.1.0` is the latest stable release:

```text
feature PR with patch changeset -> main -> 1.1.1-beta.1
feature PR with patch changeset -> main -> 1.1.1-beta.2
feature PR with minor changeset -> main -> 1.2.0-beta.3
Changesets release PR merge    -> main -> v1.2.0 -> stable images
next feature PR                -> main -> 1.2.1-beta.1
```

The target version can escalate as Changesets accumulate while the beta ordinal continues to identify integration revisions since the latest stable tag.

### Version sources of truth

- `package.json` on `main` contains the latest stable version until the Changesets release PR is merged.
- Pending `.changeset/*.md` files determine the next stable version. `pnpm changeset status --output <file>` already emits `releases[].newVersion` and selects the largest pending bump.
- A beta build transiently changes the checked-out `package.json` to `<next-version>-beta.<N>` before building. It never commits that change or consumes Changesets.
- The stable version is materialized only by the Changesets release PR, which updates `package.json`, writes `CHANGELOG.md`, and removes consumed fragments.
- The stable Git tag must equal `v${package.json.version}` and point to the release PR merge commit.

### Beta ordinal

Use first-parent integration distance from the latest stable Git tag:

```bash
git rev-list --count --first-parent "v${stable_version}..${GITHUB_SHA}"
```

This is deterministic and idempotent for reruns. With protected `main` and merge/squash PRs, one merged PR advances the ordinal once. A direct push containing multiple commits advances it once per commit; exact push-count semantics would require an external mutable counter and are intentionally out of scope.

Beta tags start at `.1`. Protect `main`, prohibit force pushes, and normally require pull requests so first-parent history remains the integration ledger.

## Image tags

Build once per release channel and push the same digest to both registries.

### Beta

For `1.2.0-beta.3`:

- `v1.2.0-beta.3`
- `v1.2-beta`
- `v1-beta`
- `beta`
- `sha-<short-sha>`

Beta builds must never update `latest`, `v1`, or `v1.2`.

### Stable

For `1.2.0`:

- `v1.2.0`
- `v1.2`
- `v1`
- `latest`
- `sha-<short-sha>`

Before publishing, verify that the package version has no prerelease suffix and that the Git tag is exactly `v${package.json.version}`.

### Immutable publication invariant

Treat a release as an explicit identity tuple: channel, complete version, and commit SHA. Its immutable registry references are the exact version and SHA aliases in both registries; its canonical digest is the one digest to which all four references resolve.

Before any registry write, inspect every immutable reference that already exists:

- If none exist, build once and publish the resulting digest to all immutable references.
- If one or more exist, require every existing reference to resolve to one digest and verify its OCI version/revision labels against the release identity. Reuse that digest and copy it to missing references without rebuilding.
- If existing digests or labels conflict, fail closed without changing either registry.

After publication, re-inspect both registries and mark the immutable image complete only when every exact/SHA reference resolves to the canonical digest with matching identity labels. A release is complete only when that registry invariant holds and its immutable Git tag points to the same commit. Git tags therefore identify releases but are not publication-completion markers.

## Target workflow architecture

### `.github/workflows/publish-container.yml`

Create one reusable `workflow_call` workflow for the shared container build.

Inputs:

- `channel`: `beta` or `stable`
- `version`: complete semantic version
- `ref`: commit SHA to build

Responsibilities:

1. Validate the channel/version contract.
2. Check out the exact supplied SHA.
3. For beta only, update `package.json` transiently to the supplied prerelease version.
4. Generate immutable exact/SHA references and OCI version/revision/source labels for Docker Hub and GHCR.
5. Inspect existing immutable references and classify publication state as absent, partial-valid, complete, or conflicting.
6. Build once only when state is absent; when state is partial-valid, copy the canonical digest to missing references without rebuilding.
7. Fail before writes on conflicting digests/identity labels, and verify all immutable references after writes.
8. Expose the canonical digest and verified completion state in the job summary.

The reusable publisher is an immutable-state reconciler and never updates moving aliases. A separate promotion operation copies its verified canonical digest to channel aliases without rebuilding, so immutable publication and mutable channel movement have distinct failure and concurrency boundaries. The calling workflow supplies only the permissions and secrets it needs, and third-party actions use immutable commit SHAs.

### `.github/workflows/container.yml`

Convert the existing workflow into the beta orchestrator for pushes to `main`.

Responsibilities:

1. Check out full history and tags.
2. Install dependencies with the frozen lockfile.
3. Run `pnpm changeset status --output <file>`.
4. Skip publishing when no Honeybot release is pending. This prevents the Changesets release merge itself from becoming a beta build.
5. Read the pending `honeybot` `newVersion`; reject missing, duplicate, or unexpected package releases.
6. Resolve the stable baseline and calculate the first-parent beta ordinal.
7. Produce `<next-version>-beta.<N>` and its immutable Git tag.
8. Fetch that Git tag before any registry write: continue if absent, allow a rerun if it points to the current SHA, and fail closed if it points elsewhere.
9. Invoke `publish-container.yml` to reconcile all immutable exact/SHA references for the current release identity, reusing a valid partial digest and rejecting conflicts.
10. After verified immutable publication, create/push the beta Git tag if absent and assert the complete publication invariant.

Do not apply branch-wide cancellation to immutable publication. Distinct beta versions may reconcile concurrently because their references cannot collide; same-version reruns use a version-scoped, non-canceling concurrency group so a run cannot be interrupted between registry reconciliation and Git-tag creation.

Run moving-alias promotion as a separate serialized reconciler. Each attempt ignores the triggering event SHA, resolves the live remote `main` tip, requires that commit's beta publication to be complete, and copies its canonical digest to `beta`, major-beta, and minor-beta aliases without rebuilding. Re-read the live tip after promotion: finish only when it still equals the promoted tip; otherwise repeat within a bounded attempt budget, then unconditionally dispatch a successor reconciliation before exiting. A failed successor dispatch fails the job loudly. GitHub may replace pending reconciler runs safely because every surviving run targets live repository state rather than its original event. Under eventual `main` quiescence, this guarantees convergence without claiming an unavailable registry compare-and-swap.

### `.github/workflows/release.yml`

Keep the existing Changesets version-PR job and add stable-release orchestration.

Generate a short-lived installation token from a dedicated GitHub App with only repository contents and pull-request write permissions, and pass it to `changesets/action`. Unlike `GITHUB_TOKEN`, the App token allows release-PR `pull_request` events to run required CI without entering `action_required`; pin the token action to an immutable SHA and fail closed when App credentials are unavailable.

On each push to `main`:

1. Continue running `changesets/action` with the GitHub App token so `changeset-release/main` is created or updated from pending fragments and receives normal CI.
2. In the stable-orchestration job, check out full first-parent history and tags with `fetch-depth: 0`.
3. Find the latest complete stable release, then scan first-parent commits after its SHA through the current remote `main` tip for every stable `package.json` version transition, including transitions that already have Git tags. Validate each candidate against its first parent, consumed Changesets, and `CHANGELOG.md`; do not infer the release solely from the current push's `before`/`sha` pair.
4. Reconcile every candidate oldest-first. For each exact release SHA:
   - require a valid increasing stable semantic version;
   - fetch and preflight `vX.Y.Z`: fail if it points elsewhere, accept it if it already points to the release SHA, or continue only when absent;
   - when absent, check out the release SHA before running `pnpm changeset tag`, then verify and push the resulting tag so a later batched commit cannot become the target;
   - invoke `publish-container.yml` to reconcile both registries from absent, partial-valid, or complete state;
   - require the Git tag and every immutable registry reference to satisfy the publication invariant before advancing.
5. After all stable candidates are complete, promote stable major/minor/`latest` aliases from the newest canonical digest without rebuilding.

Use a branch-wide, non-canceling stable-publication concurrency group. GitHub can replace pending concurrency runs, so correctness comes from the self-healing state scan: any surviving later run starts after the latest complete release and recovers skipped events, pre-existing tags, and partial registry publication. Do not rely on the `GITHUB_TOKEN`-created tag to trigger another workflow; the originating release run directly invokes the reusable publisher.

A manual `workflow_dispatch` recovery path runs the same state reconciler for an existing stable tag after validating that the tag, commit, and package version agree. It must not create or move release tags.

### `scripts/releaseMetadata.ts`

Move release calculations out of YAML shell blocks into a small typed script so they can be tested locally.

Suggested pure operations:

- Parse and validate Changesets status JSON for the single `honeybot` package.
- Build and validate beta versions.
- Validate stable tag/package-version agreement.
- Generate beta and stable image aliases for both registries.
- Classify observed Git/registry state as absent, partial-valid, complete, or conflicting and derive the required reconciliation actions.
- Select the latest complete stable release and every later version transition requiring reconciliation.
- Produce GitHub output values and a human-readable summary.

Keep Git operations at the script boundary and release-policy calculations pure.

### `tests/releaseMetadata.test.ts`

Cover:

- Patch, minor, and major pending versions from Changesets status.
- Largest-bump behavior as reflected in `newVersion`.
- No pending release returns an explicit skip result.
- Unexpected package names or multiple Honeybot release records fail closed.
- Beta ordinals start at one and produce valid SemVer.
- Target escalation preserves the integration ordinal.
- Beta aliases never contain stable aliases.
- Stable aliases include `latest`, major, minor, exact, and SHA tags.
- Prerelease versions are rejected for stable publishing.
- Stable Git tag/package mismatches are rejected.
- Fully absent immutable references request one build.
- Partial matching registry state reuses its canonical digest and fills only missing references.
- Conflicting digests or OCI identity labels fail closed before registry writes.
- Stable transition scanning identifies the exact release commit inside a multi-commit range and includes tagged-but-incomplete releases.
- Alias reconciliation derives its target from the live `main` tip rather than the triggering event SHA.
- A tip change during the final promotion attempt requires a successor reconciliation.
- Rerunning the same SHA produces identical metadata.

## Implementation sequence

### Commit 1: Add tested release metadata calculation

Files:

- Add `scripts/releaseMetadata.ts`.
- Add `tests/releaseMetadata.test.ts`.
- Add a narrow package script if useful for workflow invocation.

Verification:

```bash
pnpm lint
pnpm typecheck
pnpm test -- tests/releaseMetadata.test.ts
```

### Commit 2: Extract the reusable container publisher

Files:

- Add `.github/workflows/publish-container.yml`.
- Remove duplicated build/tag generation from `.github/workflows/container.yml` only after callers are ready.

Requirements:

- One multi-architecture build when no immutable state exists; valid partial state is completed by copying its canonical digest without rebuilding.
- Both registries' exact/SHA references resolve to the same verified digest and release identity.
- Conflicting existing immutable state fails before any registry write.
- Moving aliases are promoted from the immutable digest by a separate state-based reconciler.
- Third-party actions use immutable SHAs.
- Permissions are least-privilege.

Verification:

- Parse all workflow YAML.
- Run `actionlint` in a pinned container or CI tool.
- Exercise metadata generation for representative beta/stable inputs without registry login.
- Seed absent, complete, one-registry-only, one-alias-only, and conflicting immutable states; confirm build/copy/skip/fail behavior and post-write digest equality.
- Verify immutable publication and moving-alias promotion are separate jobs/steps with no second build.

### Commit 3: Make `main` publish beta images only

Files:

- Rewrite `.github/workflows/container.yml` as the beta orchestrator.
- Wire it to the reusable publisher.

Requirements:

- No pull-request publishing.
- No stable aliases from a `main` push.
- No beta publish when Changesets reports no pending release.
- Full Git history/tags are available for the ordinal.
- Existing beta Git and registry references are validated before any registry write.
- Beta tag creation occurs only after successful immutable image reconciliation.
- Immutable publication uses version-scoped, non-canceling concurrency; distinct versions may publish concurrently.
- Moving aliases are handled by a separate serialized reconciler that ignores stale event SHAs, requires complete publication state, and converges on the live `main` tip.

Verification:

- Dry-run metadata for current `main`: pending `1.1.0` from `.changeset/quick-text-repeats.md`.
- Confirm the current stable package version remains untouched in Git.
- Confirm mismatched existing Git tags, registry digests, or OCI identity labels fail before registry publication.
- Confirm matching partial registry state is completed from its canonical digest without a rebuild.
- Simulate cancellation requests after immutable publication begins and confirm the publication/tag transaction is non-canceling.
- Simulate out-of-order events for two successive `main` SHAs and confirm every reconciler targets the live remote tip.
- Force a tip change on the final in-process attempt and confirm the reconciler dispatches a successor; a dispatch failure must fail the job.
- Confirm `latest` cannot appear in beta outputs.

### Commit 4: Tag and publish stable releases automatically

Files:

- Extend `.github/workflows/release.yml`.
- Wire stable release detection to the reusable publisher.

Requirements:

- A short-lived GitHub App installation token lets Changesets-created/updated release PRs run required CI automatically.
- Stable-version detection scans first-parent history from the latest complete stable release rather than trusting one push event boundary or Git tag presence.
- Every stable package transition is tied to and published from its exact release-PR merge commit, even when a push contains later commits.
- `changeset tag` creates `vX.Y.Z` for this single-package private repository from a checkout of that exact release SHA.
- The release workflow directly calls the publisher after tagging.
- Non-canceling serialization plus the self-healing scan recovers version bumps whose original workflow event never ran and tagged releases whose registry publication was interrupted.
- Reruns reconcile partial registry state, are idempotent, and never move an existing tag.
- Stable images update exact/minor/major/`latest` tags in both registries.

Verification:

- Simulate a push containing a release-PR merge followed by ordinary commits and confirm the tag/image use the release merge SHA.
- Simulate a skipped/canceled intermediate push event and confirm the next run finds every stable transition since the latest complete release.
- Simulate failure immediately after Git-tag creation and confirm the next automatic run completes both registries.
- Confirm multiple incomplete releases, whether tagged or untagged, are processed oldest-first.
- Confirm an existing mismatched Git tag or immutable registry reference fails before image publication.
- Confirm a Changesets release PR created or updated with the App token starts CI without `action_required`.
- Confirm stable moving aliases finish on the newest successfully published stable digest.

### Commit 5: Document channels and rollout

Files:

- Update `README.md` image-tag and development/release sections.
- Add a Changeset for the new externally visible beta distribution channel. It should be minor; the already pending minor release means it will join the same `1.1.0` train.

Document:

- `main` is the beta/integration channel.
- Stable production is represented by immutable `vX.Y.Z` Git tags.
- Which Docker tags are moving versus immutable.
- How to promote by merging the Changesets release PR.
- How to recover/re-publish without moving a stable tag.
- Beta database users should back up persistent data because downgrades are not guaranteed after schema migrations.

## Migration and rollout

1. Keep PR #10 (`changeset-release/main`) open until this workflow change is merged.
2. Restore the missing release invariant for the current package version by creating `v1.0.1` at merge commit `67813a8`, after verifying that commit contains `package.json` version `1.0.1`. Do not move `v1.0.0`.
3. Create and install a dedicated release-automation GitHub App with only repository contents and pull-request write permissions; configure its App ID and private key as repository Actions secrets before merging workflow code.
4. Merge the workflow implementation into `main` with its minor Changeset.
5. Verify that the first beta run:
   - derives the pending next version as `1.1.0`;
   - preflights the immutable beta Git tag and both registries before either registry is modified;
   - publishes beta-only aliases to Docker Hub and GHCR;
   - verifies exact/SHA aliases in both registries resolve to one canonical digest;
   - leaves `latest` unchanged;
   - creates the matching immutable beta Git tag.
6. Confirm Changesets updates PR #10 with the GitHub App token, includes both release notes while retaining minor `1.1.0`, and starts required CI without an `action_required` run.
7. Merge PR #10 as the first production exercise of the stable workflow only after that CI passes.
8. Verify that the release scanner identifies PR #10's exact merge commit, creates `v1.1.0` there, establishes complete immutable registry state for that commit, and only then promotes `v1.1`, `v1`, and `latest` to its canonical digest.
9. Verify that the subsequent no-changeset `main` state does not publish a beta image.
10. Protect `main`: require pull requests and CI, block force pushes/deletion, and limit direct pushes. Enable these requirements only after the App-authored PR #10 update proves the automated release-PR CI path works.

## Validation checklist

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm changeset status --output /tmp/changeset-status.json
ruby -e 'require "yaml"; Dir[".github/workflows/*.{yml,yaml}"].each { |f| YAML.parse_file(f) }'
git diff --check origin/main...HEAD
```

Also validate workflow semantics with `actionlint`, then exercise the first beta and stable runs against both registries. Compare manifests with `docker buildx imagetools inspect`; confirm all immutable aliases resolve to the canonical digest, seed partial/conflicting states to exercise reconciliation, and confirm moving aliases end at the newest complete channel release.

## Acceptance criteria

- [ ] Feature PRs continue to target `main`; no permanent `stable` branch is introduced.
- [ ] Each eligible `main` integration publishes a deterministic `<next-version>-beta.<N>` image when Changesets has pending release intent.
- [ ] Beta versions are transient and are never committed to `main`.
- [ ] Beta builds publish only beta/exact/SHA aliases and never update `latest` or stable major/minor aliases.
- [ ] Existing immutable beta Git/registry references are validated before registry writes; partial state is completed from one canonical digest, conflicts fail closed, and publish/tag transactions are not canceled after writes begin.
- [ ] A serialized state-based reconciler promotes moving beta aliases from the live `main` tip and guarantees convergence under eventual quiescence through bounded retries plus mandatory successor dispatch, without relying on registry compare-and-swap.
- [ ] Changesets aggregates all fragments and uses the largest semantic bump in its release PR.
- [ ] Changesets-created or updated release PRs run required CI automatically through a least-privilege GitHub App token.
- [ ] Merging the Changesets release PR automatically creates an immutable matching `vX.Y.Z` Git tag.
- [ ] The same release run automatically publishes stable images to Docker Hub and GHCR.
- [ ] Stable history scanning starts after the latest complete release and recovers every later transition from its exact release-PR merge SHA, including tagged releases with interrupted registry publication.
- [ ] Stable builds publish exact/minor/major/`latest`/SHA aliases from the release merge SHA.
- [ ] Automated tag creation does not depend on a suppressed follow-up `push` workflow.
- [ ] Pull requests never publish images.
- [ ] Workflow reruns reconcile valid partial registry state without rebuilding, fail closed on immutable conflicts, and never move an existing release tag.
- [ ] Version/tag calculations have focused unit coverage and all existing validation remains green.

## Rollback

- Disable the beta job without touching stable tags or images.
- Re-run the stable publisher against the last known-good immutable stable tag to restore moving Docker aliases.
- Never delete or move a published stable Git tag; release a new patch version for corrections.
- Revert workflow code independently of application code. Pending Changesets remain intact until a release PR is merged.

## Known risks

- The current repository lacks `v1.0.1`; beta numbering should not go live until that baseline is restored or an explicit alternate baseline is chosen.
- `main` is currently unprotected, so direct/force pushes can undermine deterministic integration numbering.
- Release automation depends on a dedicated GitHub App; missing, expired, or overprivileged App credentials must fail closed and block release-PR updates rather than falling back to `GITHUB_TOKEN`.
- Docker Hub and GHCR publication can partially succeed. The immutable-state reconciler must preserve one verified canonical digest, safely fill missing references without rebuilding, fail closed on conflicts, and promote moving aliases only from complete publication state.
- Database migrations exercised by beta images may make rollback to stable unsafe; beta deployments require backups.
- GitHub suppresses tag-triggered workflows when the tag is pushed with `GITHUB_TOKEN`; stable build orchestration must remain in the originating release run.
