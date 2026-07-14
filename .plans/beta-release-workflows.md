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
- The stable Git tag must equal `v${package.json.version}` and peel to the release PR merge commit. All tag-to-commit comparisons resolve the full commit target with `git rev-parse --verify "refs/tags/${tag}^{commit}"`; callers never compare a raw `refs/tags/*` object SHA, because Changesets creates annotated tags.

### Beta eligibility, baseline readiness, and ordinal

Resolve a typed stable-baseline state before calculating beta metadata. The state is `ready` only when the stable version in the live `main` snapshot has a matching Git tag at its release commit and both registries satisfy the complete stable publication invariant. If `package.json` has advanced but that tag/publication is absent or incomplete, return `deferred` without running revision-range commands or writing Git/registry state; successful stable reconciliation dispatches a beta successor after completing the baseline.

An eligible beta integration is a first-parent `main` commit after the latest complete stable baseline whose exact snapshot has pending `honeybot` Changesets release intent. It remains eligible until a later complete stable release supersedes that integration. The beta reconciler scans the current stable epoch from the baseline tag through a freshly fetched live `main` tip and processes every eligible commit oldest-first, so skipped/replaced workflow events do not lose beta publications.

For each eligible `candidate_sha`, use first-parent integration distance from the ready stable tag:

```bash
git rev-list --count --first-parent "v${stable_version}..${candidate_sha}"
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
- `sha-<full-commit-sha>`

Beta builds must never update `latest`, `v1`, or `v1.2`.

### Stable

For `1.2.0`:

- `v1.2.0`
- `v1.2`
- `v1`
- `latest`
- `sha-<full-commit-sha>`

Before publishing, verify that the package version has no prerelease suffix and that the Git tag is exactly `v${package.json.version}`.

### Immutable publication invariant

Treat a release as an explicit identity tuple: channel, complete version, and commit SHA. Its immutable registry references are the exact version and SHA aliases in both registries; its canonical digest is the one digest to which all four references resolve. The SHA alias is `sha-${ref}`, where `ref` is the full, unabbreviated 40-character lowercase hexadecimal commit SHA; shortened SHAs are never valid immutable identifiers.

Before any registry write, inspect every immutable reference that already exists:

- If none exist, build once and publish the resulting digest to all immutable references.
- If one or more exist, require every existing reference to resolve to one digest and verify its OCI version/revision labels against the release identity. Reuse that digest and copy it to missing references without rebuilding.
- If existing digests or labels conflict, fail closed without changing either registry.

After publication, re-inspect both registries and mark the immutable image complete only when every exact/SHA reference resolves to the canonical digest with matching identity labels. A release is complete only when that registry invariant holds and its immutable Git tag peels to the same commit. Git tags therefore identify releases but are not publication-completion markers.

### Guarded legacy baseline adoption

The existing `v1.0.1` registry references predate this invariant and have been moved by later `main` builds, so normal reconciliation must continue to classify them as conflicts rather than gaining a general overwrite switch. Add a separate typed administrative command, `scripts/adoptLegacyStableRelease.ts`, for this one migration class.

Require explicit `version`, full `ref`, `expectedLegacyDigest`, and `expectedLegacyRevision` inputs. Before writes, verify the package version at `ref`; require `v${version}` to be absent, or for its peeled commit target to equal `ref` only when the target registry identity is already complete; require every existing exact reference in both registries to be either the explicitly expected untagged legacy identity or the target identity; and require full-SHA references to be absent or match the target. Any unlisted digest, label, or Git-tag state fails closed.

Build the exact target ref once only when no target canonical digest exists. Preserve that digest across partial retries, replace only the explicitly authorized untagged legacy exact references, create the full-SHA references in both registries, and verify all target digests and OCI identity labels. Configure the shared repository-local automation identity before creating the annotated immutable Git tag, and create/push that tag only after registry verification; a rerun may complete valid partial target state without rebuilding. After the tag exists, ordinary stable reconciliation repairs moving aliases. This migration path must not weaken the normal publisher's rule that immutable conflicts are never overwritten.

## Target workflow architecture

### `scripts/containerPublication.ts`

Create one typed module/CLI for shared immutable container reconciliation. This is deliberately not a reusable `workflow_call`: GitHub can invoke reusable workflows only as jobs, which cannot be called inside the stable job's ordered candidate loop.

Inputs:

- `channel`: `beta` or `stable`
- `version`: complete semantic version
- `ref`: commit SHA to build

Responsibilities:

1. Validate the channel/version contract and require `ref` to be a full 40-character lowercase hexadecimal commit SHA.
2. Create a temporary detached worktree at the exact supplied SHA when a build is required.
3. For beta only, update `package.json` transiently inside that worktree.
4. Generate the immutable `sha-${ref}` alias, exact-version references, and OCI version/revision/source labels for Docker Hub and GHCR.
5. Inspect existing immutable references and classify publication state as absent, partial-valid, complete, or conflicting.
6. Build once only when state is absent; when state is partial-valid, copy the canonical digest to missing references without rebuilding.
7. Fail before writes on conflicting digests/identity labels, and verify all immutable references after writes.
8. Return the canonical digest and verified completion state as typed data and GitHub outputs.

The beta reconciliation script imports this module and calls it sequentially for every eligible integration in the current stable epoch; the stable reconciliation script does the same for each release candidate. Workflows remain responsible for pinned QEMU/Buildx setup, registry authentication, permissions, secrets, and job summaries. The module never updates moving aliases: separate state reconcilers copy only verified canonical digests to channel aliases, preserving distinct immutable-publication and mutable-promotion failure boundaries.

### `.github/workflows/container.yml`

Convert the existing workflow into the state-based beta orchestrator for pushes to `main`, and add a typed `workflow_dispatch` input with two internal modes: `reconcile-beta` and `promote-aliases`. A `push` run performs immutable beta reconciliation followed by moving-alias reconciliation; `reconcile-beta` performs the same live-history reconciliation after a stable-baseline handoff; `promote-aliases` runs only moving-alias reconciliation.

Keep workflow-level permissions read-only. Grant the immutable-publication job only `contents: write` and `packages: write`, and grant the promotion job `contents: read`, `packages: write`, and `actions: write`. The promotion job uses `actions: write` solely to dispatch a required `reconcile-beta` or `promote-aliases` successor with its `GITHUB_TOKEN`; no other container job receives that permission.

Immutable beta reconciliation (`push` or `reconcile-beta` mode):

1. Check out full history and tags, install frozen dependencies, and fetch the live remote `main` tip.
2. Invoke `scripts/reconcileBetaReleases.ts` to resolve the latest complete stable baseline and compare it with the stable package version at the live tip.
3. If the live package version's stable tag/publication is incomplete, return an explicit `deferred` result without revision-range commands or writes. Stable reconciliation owns completion and the successor handoff.
4. From a ready baseline, scan every first-parent commit through the captured live tip. In a detached worktree at each exact commit, parse Changesets status; skip no-release snapshots and stable release transitions, and collect every current-epoch eligible integration oldest-first.
5. For each candidate, derive `<next-version>-beta.<N>` from that snapshot and its first-parent distance from the ready baseline tag. Preflight the immutable beta Git tag by comparing its peeled commit target before registry writes, reconcile exact/full-SHA references through `containerPublication`, then create the Git tag only after verified publication.
6. Treat already complete candidates as idempotent no-ops and recover partial-valid candidates from their canonical digest without rebuilding. Any conflicting tag, digest, or identity label stops later candidates before their writes.
7. Re-fetch the live tip after the pass. If new eligible history appeared, report that `reconcile-beta` successor work is required; the promotion job performs the dispatch with its restricted `actions: write` permission.

Use one branch-wide beta-publication concurrency group with `cancel-in-progress: false`. GitHub may replace pending runs, but every surviving run scans live first-parent state and reconciles all still-eligible current-epoch commits, so correctness does not depend on receiving every push event.

Concurrency settings are scheduling controls, not transaction boundaries. Manual cancellation, timeouts, runner loss, or process failure can still interrupt a run between registry reconciliation and Git-tag creation. Correctness therefore comes from the explicit publication invariant and idempotent recovery: a later scan re-inspects state, reuses a verified canonical digest without rebuilding, completes missing registry references or the Git tag, and fails closed on conflicts.

Run moving-alias promotion as a separate serialized reconciler after successful immutable reconciliation and for `promote-aliases` dispatches. Each attempt ignores the triggering event SHA, resolves the live remote `main` tip, then selects the newest complete beta publication whose tagged commit is reachable on that tip's first-parent history. If none exists, exit as an explicit no-op. Copy the selected canonical digest to `beta`, major-beta, and minor-beta aliases without rebuilding, then recompute the selection from a fresh `main` fetch. Finish when the selected release identity is unchanged; otherwise repeat within a bounded attempt budget. If the budget is exhausted before the selection stabilizes, dispatch `promote-aliases`; if immutable reconciliation reported newer eligible history, dispatch `reconcile-beta` instead. A failed successor dispatch fails the job loudly. No-Changeset pushes and stable release merges naturally retain the previous beta selection until stable reconciliation completes its handoff. Under eventual `main` quiescence, this guarantees convergence without claiming an unavailable registry compare-and-swap.

### `.github/workflows/release.yml`

Keep the existing Changesets version-PR job and add stable-release orchestration. Retain default read-only workflow permissions, then grant capabilities per job: the version-PR job receives `contents: write` and `pull-requests: write`; the stable job receives `contents: write`, `packages: write`, and `actions: write`. The stable job uses `actions: write` only for the post-reconciliation `reconcile-beta` handoff, and must receive `packages: write` before any registry login or tag mutation so a missing permission cannot strand a Git tag without its GHCR image.

Generate a short-lived installation token from a dedicated GitHub App with only repository contents and pull-request write permissions, and pass it to `changesets/action`. Unlike `GITHUB_TOKEN`, the App token allows release-PR `pull_request` events to run required CI without entering `action_required`; pin the token action to an immutable SHA and fail closed when App credentials are unavailable.

On each push to `main`:

1. Continue running `changesets/action` with the GitHub App token so `changeset-release/main` is created or updated from pending fragments and receives normal CI.
2. In one stable-orchestration job, check out full first-parent history and tags with `fetch-depth: 0`; configure repository-local Git identity as `github-actions[bot]` / `41898282+github-actions[bot]@users.noreply.github.com`; verify both values; set up the pinned pnpm and Node versions; run `pnpm install --frozen-lockfile`; then set up QEMU/Buildx, authenticate both registries, and invoke `scripts/reconcileStableReleases.ts`. Jobs share no filesystem, dependency, or Git-identity state, so this setup is required independently of the version-PR job and must complete before any tag command.
3. The script finds the latest complete stable release, then scans first-parent commits after its SHA through the current remote `main` tip for every stable `package.json` version transition, including transitions that already have Git tags. It validates each candidate against its first parent, consumed Changesets, and `CHANGELOG.md`; it does not infer the release solely from the current push's `before`/`sha` pair.
4. The script reconciles every candidate oldest-first in-process. For each exact release SHA it:
   - requires a valid increasing stable semantic version;
   - fetches and preflights `vX.Y.Z` through the shared Git adapter, failing if its peeled `^{commit}` target differs and accepting annotated or lightweight tags that peel to the release SHA;
   - when absent, creates a temporary detached worktree at the release SHA, applies and verifies the shared repository-local automation identity for that worktree, runs a frozen dependency install followed by `pnpm changeset tag`, then verifies the annotated tag's peeled commit target and pushes it so a later batched commit cannot become the target;
   - calls the shared `containerPublication` module to reconcile both registries from absent, partial-valid, or complete state;
   - requires the Git tag and every immutable registry reference to satisfy the publication invariant before advancing.
5. After every immutable candidate is complete, derive the desired stable alias map across all complete stable releases: each minor alias points to the newest release in that minor line, each major alias to the newest release in that major line, and `latest` to the newest release globally. Reconcile the entire map from canonical digests without rebuilding, repairing aliases for every recovered release line rather than only the newest release.
6. After the stable scan and alias map are complete—even when no new stable candidate was required—dispatch `container.yml` with `mode: reconcile-beta` and `ref: main`. This explicit handoff re-fetches live history after baseline readiness, recovers integrations deferred while the matching stable tag/publication was incomplete, and fails the stable job loudly if dispatch cannot be queued.

Use a branch-wide stable-publication concurrency group with `cancel-in-progress: false`, preventing a newer run from canceling the active run through GitHub concurrency. GitHub can still replace pending concurrency runs, and manual cancellation, timeouts, runner loss, or process failure can interrupt the active run, so correctness comes from the self-healing state scan and desired alias-map reconciliation. Any surviving later run recovers skipped events, pre-existing tags, partial registry publication, and missing major/minor aliases. Do not rely on the `GITHUB_TOKEN`-created tag to trigger another workflow; the originating release job performs the ordered transaction directly.

A manual `workflow_dispatch` recovery path runs the same state reconciler for an existing stable tag after validating that the tag, commit, and package version agree. It must not create or move release tags.

### Shared Git tag adapter

Keep tag identity and creation prerequisites behind one narrow adapter used by beta reconciliation, stable reconciliation, and guarded legacy adoption. `resolveTagCommit(tag)` fetches the exact tag ref and returns the full commit SHA from `git rev-parse --verify "refs/tags/${tag}^{commit}"`; an absent ref returns an explicit absent state, while a tag that cannot peel to a commit fails closed. `configureAutomationIdentity(worktree)` sets repository-local `user.name=github-actions[bot]` and `user.email=41898282+github-actions[bot]@users.noreply.github.com`, reads both values back, and fails before tag or registry writes if configuration is unavailable. Tag-object SHAs are never release identities, every annotated-tag command runs only after that identity precondition, and every post-creation check repeats the same peeled-target comparison.

### `scripts/reconcileBetaReleases.ts`

Keep current-epoch beta discovery and ordered side effects in one typed process. The script owns live-tip fetching, typed baseline readiness (`ready` or `deferred`), per-commit Changesets inspection, oldest-first candidate reconciliation through `containerPublication`, beta-tag preflight/creation, completion checks, and successor-work output. External Git, registry, and Docker operations sit behind narrow adapters; a conflicting candidate stops later candidates, while complete and partial-valid candidates remain idempotently recoverable.

### `scripts/reconcileStableReleases.ts`

Keep ordered stable-release side effects in one typed process rather than encoding a dynamic loop in workflow YAML. The script owns candidate discovery, Git-tag preflight/creation, sequential calls to `containerPublication`, completion checks, and desired stable alias-map reconciliation. External Git, registry, and Docker operations sit behind narrow adapters so policy and state transitions remain unit-testable; any failed candidate stops later candidates and alias promotion.

### `scripts/releaseMetadata.ts`

Move release calculations out of YAML shell blocks into a small typed script so they can be tested locally.

Suggested pure operations:

- Parse and validate Changesets status JSON for the single `honeybot` package.
- Resolve stable-baseline readiness without invoking revision-range commands for an absent/incomplete baseline.
- Select every still-eligible beta integration in a captured first-parent stable epoch and derive metadata from each exact commit snapshot.
- Build and validate beta versions.
- Validate stable tag/package-version agreement.
- Generate beta and stable image aliases for both registries.
- Classify observed Git/registry state as absent, partial-valid, complete, or conflicting and derive the required reconciliation actions.
- Select the newest complete beta publication reachable from a live first-parent tip.
- Select the latest complete stable release and every later version transition requiring reconciliation.
- Derive the desired stable minor/major/`latest` alias map from all complete releases.
- Produce GitHub output values and a human-readable summary.

Keep Git operations at the script boundary and release-policy calculations pure.

### `tests/releaseMetadata.test.ts`

Cover:

- Patch, minor, and major pending versions from Changesets status.
- Largest-bump behavior as reflected in `newVersion`.
- No pending release returns an explicit skip result.
- Unexpected package names or multiple Honeybot release records fail closed.
- A matching complete stable tag/publication produces a ready baseline; an advanced package version with an absent/incomplete tag or registry identity produces `deferred` without writes.
- Beta ordinals start at one and produce valid SemVer for each exact candidate SHA.
- Target escalation preserves the integration ordinal.
- Current-epoch scanning recovers multiple eligible commits oldest-first after replaced/skipped push events and excludes no-release snapshots and stable transitions.
- Beta aliases never contain stable aliases.
- Stable aliases include `latest`, major, minor, exact, and SHA tags.
- Short or malformed commit SHAs are rejected, and SHA aliases embed the full 40-character `ref`.
- Prerelease versions are rejected for stable publishing.
- A clean-runner Git fixture with no global identity configures the deterministic repository-local automation identity before annotated tag creation; configuration failure aborts before writes and no global Git config is required or modified.
- Lightweight and Changesets-created annotated tags that peel to the expected commit are accepted; raw annotated-tag object SHAs are never compared as release identities, and tags that peel elsewhere or not to a commit are rejected.
- Stable Git tag/package mismatches are rejected.
- Fully absent immutable references request one build.
- Partial matching registry state reuses its canonical digest and fills only missing references.
- Conflicting digests or OCI identity labels fail closed before registry writes.
- Stable transition scanning identifies the exact release commit inside a multi-commit range and includes tagged-but-incomplete releases.
- Beta alias selection chooses the newest complete beta ancestor, remains unchanged across no-release tips, and returns an explicit no-op when none exists.
- Stable alias maps preserve every recovered major/minor line while assigning `latest` only to the newest complete release.
- A selected-beta change during the final promotion attempt requires a successor reconciliation.
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

### Commit 2: Extract the shared container publication module

Files:

- Add `scripts/containerPublication.ts`.
- Add `scripts/adoptLegacyStableRelease.ts` as the separately guarded administrative path for untagged legacy exact references.
- Add `tests/containerPublication.test.ts` with fake Git/registry/Docker adapters, including legacy-adoption cases.
- Remove duplicated build/tag policy from `.github/workflows/container.yml` only after callers are ready.

Requirements:

- One multi-architecture build when no immutable state exists; valid partial state is completed by copying its canonical digest without rebuilding.
- Both registries' exact/SHA references resolve to the same verified digest and release identity.
- Conflicting existing immutable state fails before any registry write.
- The legacy-adoption command requires the exact expected legacy digest and revision, refuses any existing conflicting Git tag or unlisted registry identity, writes and verifies the target exact/full-SHA references before creating the Git tag, and cannot be enabled through the normal publisher.
- Moving aliases are promoted from the immutable digest by a separate state-based reconciler.
- The module is callable once by beta orchestration and repeatedly in-process by stable orchestration; it has no GitHub job/workflow dependency.
- Third-party actions use immutable SHAs in each caller's environment-setup steps.
- Permissions are least-privilege.

Verification:

- Parse all workflow YAML.
- Run `actionlint` in a pinned container or CI tool.
- Exercise metadata generation for representative beta/stable inputs without registry login.
- Seed absent, complete, one-registry-only, one-alias-only, and conflicting immutable states through fake adapters; confirm build/copy/skip/fail behavior and post-write digest equality.
- Seed matching, drifted, and partially adopted legacy state; confirm only the explicitly expected untagged legacy identity can be replaced, partial target state reuses one canonical digest, and the Git tag is created only after both registries verify.
- Confirm the CLI can run as a normal workflow step and the module can be called sequentially for multiple releases without `workflow_call`.

### Commit 3: Make `main` publish beta images only

Files:

- Rewrite `.github/workflows/container.yml` as the beta orchestrator with typed `reconcile-beta` and `promote-aliases` dispatch modes.
- Add `scripts/reconcileBetaReleases.ts` and focused adapter-driven tests.
- Wire ordered candidates to the shared `containerPublication` module.

Requirements:

- No pull-request publishing and no stable aliases from beta reconciliation.
- A missing/incomplete stable tag or publication produces a typed deferred result with no revision-range command or writes.
- Each surviving run scans the captured live stable epoch and reconciles every still-eligible Changesets-bearing integration oldest-first; correctness does not depend on one run per push.
- Full Git history/tags are available for baseline resolution and ordinals.
- Existing beta Git and registry references are validated before any registry write, and beta tags are created only after successful immutable image reconciliation.
- Branch-wide beta publication uses `cancel-in-progress: false`; later scans recover replaced pending events and other interruptions from Git/registry state.
- Moving aliases are handled by a separate serialized reconciler that ignores stale event SHAs and converges on the newest complete beta publication reachable from the live `main` tip.

Verification:

- Dry-run metadata for current `main`: pending `1.1.0` from `.changeset/quick-text-repeats.md`.
- Confirm the current stable package version remains untouched in Git.
- Simulate a release merge that advances `package.json` before its stable tag/publication is complete, followed by multiple Changesets-bearing pushes. Confirm those runs defer without `git rev-list` failure or writes; after a `reconcile-beta` handoff, confirm every still-eligible commit is published oldest-first from the now-ready baseline.
- Simulate replaced pending workflow events and confirm one surviving live-tip scan recovers all still-eligible candidates.
- Confirm annotated and lightweight beta tags that peel to the candidate commit are accepted, while tags whose peeled target differs fail before registry publication; matching partial registry state reuses its canonical digest without rebuilding.
- Start a second scanner after immutable publication begins and confirm GitHub concurrency does not cancel the active run. Separately inject interruption after registry reconciliation but before Git-tag creation and confirm the next scan completes the invariant without rebuilding.
- Confirm no-Changeset snapshots and stable transitions are skipped, no-Changeset tips retain the newest complete beta ancestor, and a history with no complete beta exits as a no-op.
- Force newer eligible history during the final scan and confirm the promotion job dispatches `reconcile-beta`; force a final alias-selection change and confirm it dispatches `promote-aliases`. Both dispatch failures must fail loudly.
- Confirm `latest` cannot appear in beta outputs.

### Commit 4: Tag and publish stable releases automatically

Files:

- Extend `.github/workflows/release.yml`.
- Add `scripts/reconcileStableReleases.ts` and focused tests.
- Wire stable release detection to the shared `containerPublication` module inside one ordered job.

Requirements:

- A short-lived GitHub App installation token lets Changesets-created/updated release PRs run required CI automatically.
- Stable-version detection scans first-parent history from the latest complete stable release rather than trusting one push event boundary or Git tag presence.
- Every stable package transition is tied to and published from its exact release-PR merge commit, even when a push contains later commits.
- A deterministic repository-local Git identity is configured and verified on a clean runner before `changeset tag` creates `vX.Y.Z` for this single-package private repository from a checkout of the exact release SHA.
- One typed process performs the oldest-first tag/publication transactions; it does not attempt to call a reusable workflow from a dynamic loop.
- Non-canceling serialization plus the self-healing scan recovers version bumps whose original workflow event never ran and tagged releases whose registry publication was interrupted.
- Reruns reconcile partial registry state, are idempotent, and never move an existing tag.
- Stable alias-map reconciliation updates every complete minor and major line in both registries, with `latest` reserved for the newest complete release.
- Every successful stable reconciliation dispatches the restricted `reconcile-beta` handoff after baseline completion so deferred beta history is retried from a fresh live tip.

Verification:

- Simulate a push containing a release-PR merge followed by ordinary commits and confirm the tag/image use the release merge SHA.
- Simulate a skipped/canceled intermediate push event and confirm the next run finds every stable transition since the latest complete release.
- Simulate failure immediately after Git-tag creation and confirm the next automatic run completes both registries.
- Confirm multiple incomplete releases, whether tagged or untagged, are processed oldest-first.
- Start from a clean runner with no global `user.name`/`user.email`; confirm repository-local automation identity setup succeeds before `pnpm changeset tag`, and an identity-setup failure prevents tag and registry writes.
- Confirm an existing Changesets-created annotated tag is accepted when its peeled `^{commit}` target equals the release SHA, while a tag whose peeled target or immutable registry identity mismatches fails before image publication.
- Confirm a Changesets release PR created or updated with the App token starts CI without `action_required`.
- Recover candidates across minor and major boundaries and confirm every minor/major alias is repaired while `latest` points only to the newest complete release.
- Confirm a candidate failure stops later transactions and leaves moving aliases unchanged until a successful reconciliation.
- Confirm the stable job's `actions: write` permission is limited to dispatching `container.yml` in `reconcile-beta` mode, and a failed handoff fails the job after preserving complete stable state.

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
2. Adopt `v1.0.1` as a guarded legacy baseline before enabling either reconciler:
   - verify full commit `67813a8ec9ef2cfc4ae6d66cec88345f567243ed` contains `package.json` version `1.0.1` and that Git tag `v1.0.1` is absent;
   - re-inspect `v1.0.1` in Docker Hub and GHCR immediately before migration and record its digest and OCI labels. At planning time both registries resolve to legacy digest `sha256:184efc2e80eeb9419da903f79c1e21978ddbe4a622524e0c0611aa33696c56f0` with revision `0e23803e5555277df2ed966b222a10fd6622ed09`; any drift requires a fresh explicit review rather than broadening the overwrite rule;
   - run `scripts/adoptLegacyStableRelease.ts` with that expected legacy identity and the full target ref. It builds the target once, replaces only the authorized untagged legacy exact references, creates full-SHA references in both registries, verifies one canonical digest plus target version/revision labels, and only then creates `v1.0.1` at the target commit;
   - run stable alias reconciliation and verify `v1.0`, `v1`, and `latest` resolve to the adopted canonical digest. Do not move `v1.0.0`, and do not treat pre-invariant short-SHA aliases as immutable release identities.
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
9. Verify that the subsequent no-changeset `main` state does not publish a beta image and leaves beta moving aliases on the newest complete beta ancestor without retries.
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

Also validate workflow semantics with `actionlint`, then exercise the first beta and stable runs against both registries. Compare manifests with `docker buildx imagetools inspect`; confirm all immutable aliases resolve to the canonical digest, seed partial/conflicting states to exercise reconciliation, confirm beta aliases select the newest reachable complete beta, and confirm every stable major/minor alias plus `latest` matches the derived desired map.

## Acceptance criteria

- [ ] Feature PRs continue to target `main`; no permanent `stable` branch is introduced.
- [ ] Each still-eligible integration in the current stable epoch eventually publishes a deterministic `<next-version>-beta.<N>` image when its exact snapshot has pending Changesets release intent; incomplete stable baselines defer without writes, and the stable-completion handoff recovers every deferred integration from live first-parent history.
- [ ] Beta versions are transient and are never committed to `main`.
- [ ] Beta builds publish only beta/exact/SHA aliases and never update `latest` or stable major/minor aliases.
- [ ] Existing immutable beta Git/registry references are validated before registry writes; partial state is completed from one canonical digest; conflicts fail closed; GitHub concurrency does not cancel an active publish/tag run; and idempotent reruns recover manual cancellation, timeouts, runner loss, or other interruptions.
- [ ] A serialized state-based reconciler promotes moving beta aliases from the newest complete beta publication reachable from the live `main` tip, treats no-release tips as stable selections/no-ops, and guarantees convergence under eventual quiescence through bounded retries plus an `actions: write`-authorized, promotion-only `workflow_dispatch` successor without registry compare-and-swap.
- [ ] Changesets aggregates all fragments and uses the largest semantic bump in its release PR.
- [ ] Changesets-created or updated release PRs run required CI automatically through a least-privilege GitHub App token.
- [ ] Merging the Changesets release PR automatically creates an immutable matching `vX.Y.Z` Git tag.
- [ ] The same release run automatically publishes stable images to Docker Hub and GHCR.
- [ ] Stable history scanning starts after the latest complete release and recovers every later transition from its exact release-PR merge SHA, including tagged releases with interrupted registry publication.
- [ ] Stable reconciliation publishes exact/SHA aliases from each release merge SHA and repairs the desired alias map for every complete minor/major line, with `latest` on the newest complete release.
- [ ] Automated tag creation does not depend on a suppressed follow-up `push` workflow.
- [ ] Pull requests never publish images.
- [ ] Workflow reruns reconcile valid partial registry state without rebuilding, fail closed on immutable conflicts, and never move an existing release tag.
- [ ] Version/tag calculations have focused unit coverage and all existing validation remains green.

## Rollback

- Disable the beta job without touching stable tags or images.
- Dispatch stable reconciliation against the last known-good complete stable history to restore the derived moving-alias map.
- Never delete or move a published stable Git tag; release a new patch version for corrections.
- Revert workflow code independently of application code. Pending Changesets remain intact until a release PR is merged.

## Known risks

- The current repository lacks Git tag `v1.0.1`, while both registries' legacy `v1.0.1` references currently identify a later `main` commit. Beta numbering must not go live until the guarded adoption procedure verifies and replaces that explicitly expected untagged legacy state, establishes exact/full-SHA references for commit `67813a8ec9ef2cfc4ae6d66cec88345f567243ed`, creates the matching Git tag, and repairs stable aliases—or an explicit alternate baseline is chosen.
- `main` is currently unprotected, so direct/force pushes can undermine deterministic integration numbering.
- Release automation depends on a dedicated GitHub App; missing, expired, or overprivileged App credentials must fail closed and block release-PR updates rather than falling back to `GITHUB_TOKEN`.
- Docker Hub and GHCR publication can partially succeed. The immutable-state reconciler must preserve one verified canonical digest, safely fill missing references without rebuilding, fail closed on conflicts, and promote moving aliases only from complete publication state.
- Database migrations exercised by beta images may make rollback to stable unsafe; beta deployments require backups.
- GitHub suppresses tag-triggered workflows when the tag is pushed with `GITHUB_TOKEN`; stable build orchestration must remain in the originating release run.
