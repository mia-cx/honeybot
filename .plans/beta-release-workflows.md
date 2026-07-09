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
4. Generate two disjoint tag sets for Docker Hub and GHCR: immutable exact/SHA tags and moving channel aliases.
5. Set OCI version/revision/source labels.
6. Build the multi-architecture image once, push immutable tags, and expose the resulting digest.
7. Promote moving aliases from that immutable digest only after the caller completes its channel-specific serialization and freshness checks; never rebuild while promoting aliases.
8. Expose the immutable version and digest in the job summary.

The calling workflow supplies only the permissions and secrets it needs. Pin third-party actions to immutable commit SHAs.

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
8. Before any registry write, fetch that tag from the remote: continue if absent, allow an idempotent rerun if it points to the current SHA, and fail closed if it points elsewhere.
9. Invoke `publish-container.yml` to build and push only immutable exact/SHA tags for the current SHA.
10. After successful immutable publication, create/push the beta Git tag if it was absent.
11. Promote `beta`, major-beta, and minor-beta aliases from the published digest only if the current remote `main` tip still equals the run SHA.

Serialize the entire beta publication path with a branch-level concurrency group such as `beta-publish-main`, not a same-SHA group. Cancel stale in-progress runs, recheck the remote `main` tip immediately before moving-alias promotion, and keep immutable image/Git tags even when a superseded run skips moving aliases. These guards prevent an older build from rolling moving aliases backward while preserving deterministic reruns.

### `.github/workflows/release.yml`

Keep the existing Changesets version-PR job and add stable-release orchestration.

Generate a short-lived installation token from a dedicated GitHub App with only repository contents and pull-request write permissions, and pass it to `changesets/action`. Unlike `GITHUB_TOKEN`, the App token allows release-PR `pull_request` events to run required CI without entering `action_required`; pin the token action to an immutable SHA and fail closed when App credentials are unavailable.

On each push to `main`:

1. Continue running `changesets/action` with the GitHub App token so `changeset-release/main` is created or updated from pending fragments and receives normal CI.
2. In the stable-orchestration job, check out full history and tags with `fetch-depth: 0`, explicitly fetch `github.event.before` when necessary, and verify both the before and current commits exist locally.
3. Compare `package.json` at the validated `github.event.before` and `github.sha` commits.
4. If the stable package version did not change, skip stable tagging/publishing.
5. If it changed:
   - require a valid stable semantic version;
   - require consumed Changesets/updated changelog as expected;
   - run `pnpm changeset tag` to create `vX.Y.Z` without publishing to npm;
   - accept an existing tag only if it points to the current SHA;
   - push the Git tag;
   - invoke `publish-container.yml` directly for the same SHA and stable version.

Do not rely on the `GITHUB_TOKEN`-created tag to trigger another workflow: GitHub suppresses most workflow events created by `GITHUB_TOKEN`. Calling the reusable publisher in the same release run guarantees that stable images are built.

A manual `workflow_dispatch` recovery path may republish an existing stable tag after validating that the tag, commit, and package version agree. It must not create or move release tags.

### `scripts/releaseMetadata.ts`

Move release calculations out of YAML shell blocks into a small typed script so they can be tested locally.

Suggested pure operations:

- Parse and validate Changesets status JSON for the single `honeybot` package.
- Build and validate beta versions.
- Validate stable tag/package-version agreement.
- Generate beta and stable image aliases for both registries.
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

- One multi-architecture build per channel.
- Both registries receive the same immutable tags and digest.
- Moving aliases are promoted from the immutable digest in a separate guarded step.
- Third-party actions use immutable SHAs.
- Permissions are least-privilege.

Verification:

- Parse all workflow YAML.
- Run `actionlint` in a pinned container or CI tool.
- Exercise metadata generation for representative beta/stable inputs without registry login.
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
- Existing beta tags are validated before any registry write.
- Beta tag creation occurs only after successful immutable image publishing.
- Publication is serialized for the whole `main` beta channel, and stale runs cannot update moving aliases.

Verification:

- Dry-run metadata for current `main`: pending `1.1.0` from `.changeset/quick-text-repeats.md`.
- Confirm the current stable package version remains untouched in Git.
- Confirm a mismatched existing beta tag fails before registry publication.
- Simulate two successive `main` SHAs and confirm only the current remote tip can promote moving aliases.
- Confirm `latest` cannot appear in beta outputs.

### Commit 4: Tag and publish stable releases automatically

Files:

- Extend `.github/workflows/release.yml`.
- Wire stable release detection to the reusable publisher.

Requirements:

- A short-lived GitHub App installation token lets Changesets-created/updated release PRs run required CI automatically.
- Stable-version detection fetches and validates `github.event.before` instead of assuming the shallow checkout contains it.
- Stable publication occurs only when `package.json` advances to a stable version.
- `changeset tag` creates `vX.Y.Z` for this single-package private repository.
- The release workflow directly calls the publisher after tagging.
- Reruns are idempotent and never move an existing tag.
- Stable images update exact/minor/major/`latest` tags in both registries.

Verification:

- Simulate version-change and no-version-change events against local Git refs with an initially shallow checkout.
- Confirm the workflow explicitly fetches and resolves `github.event.before` before reading its `package.json`.
- Confirm an existing mismatched tag fails before image publication.
- Confirm a Changesets release PR created or updated with the App token starts CI without `action_required`.
- Confirm the stable call builds the version-PR merge SHA, not the workflow branch head.

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
   - preflights the immutable beta Git tag before either registry is modified;
   - publishes beta-only aliases to Docker Hub and GHCR;
   - leaves `latest` unchanged;
   - creates the matching immutable beta Git tag.
6. Confirm Changesets updates PR #10 with the GitHub App token, includes both release notes while retaining minor `1.1.0`, and starts required CI without an `action_required` run.
7. Merge PR #10 as the first production exercise of the stable workflow only after that CI passes.
8. Verify that the release run creates `v1.1.0` and publishes the same stable digest to Docker Hub and GHCR under `v1.1.0`, `v1.1`, `v1`, `latest`, and the SHA tag.
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

Also validate workflow semantics with `actionlint`, then exercise the first beta and stable runs against both registries. Compare manifests with `docker buildx imagetools inspect` and confirm all aliases resolve to the same digest for their channel.

## Acceptance criteria

- [ ] Feature PRs continue to target `main`; no permanent `stable` branch is introduced.
- [ ] Each eligible `main` integration publishes a deterministic `<next-version>-beta.<N>` image when Changesets has pending release intent.
- [ ] Beta versions are transient and are never committed to `main`.
- [ ] Beta builds publish only beta/exact/SHA aliases and never update `latest` or stable major/minor aliases.
- [ ] Existing immutable beta tags are validated before registry writes, and stale/concurrent runs cannot roll moving aliases backward.
- [ ] Changesets aggregates all fragments and uses the largest semantic bump in its release PR.
- [ ] Changesets-created or updated release PRs run required CI automatically through a least-privilege GitHub App token.
- [ ] Merging the Changesets release PR automatically creates an immutable matching `vX.Y.Z` Git tag.
- [ ] The same release run automatically publishes stable images to Docker Hub and GHCR.
- [ ] Stable builds publish exact/minor/major/`latest`/SHA aliases from the release merge SHA.
- [ ] Automated tag creation does not depend on a suppressed follow-up `push` workflow.
- [ ] Pull requests never publish images.
- [ ] Workflow reruns are idempotent and never move an existing release tag.
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
- Docker Hub and GHCR publication can partially succeed. Reruns must validate immutable tags first, safely complete the missing registry, and promote moving aliases only from the current integration/release digest.
- Database migrations exercised by beta images may make rollback to stable unsafe; beta deployments require backups.
- GitHub suppresses tag-triggered workflows when the tag is pushed with `GITHUB_TOKEN`; stable build orchestration must remain in the originating release run.
