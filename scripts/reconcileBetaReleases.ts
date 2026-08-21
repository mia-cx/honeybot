import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DockerBuildxAdapter,
  promoteMovingAliases,
  publicationComplete,
  reconcilePublication,
  type PublicationAdapter,
} from './containerPublication.js';
import {
  buildBetaVersion,
  getRepositories,
  parseChangesetStatus,
  parseSemVer,
  resolveBaselineReadiness,
  type ChangesetRelease,
  type RegistryRepositories,
  type ReleaseIdentity,
} from './releaseMetadata.js';
import {
  assertExpectedTip,
  createAnnotatedTag,
  describeError,
  fetchMainAndTags,
  fetchTag,
  firstParentCommits,
  firstParentDistance,
  isAncestor,
  listTags,
  packageVersionAt,
  pushTag,
  resolveStableTagCommit,
  resolveTagCommit,
  runCommand,
  withDetachedWorktree,
} from './releaseGit.js';

export interface BetaReconcileResult {
  state: 'deferred' | 'complete';
  baselineVersion: string;
  capturedTip: string;
  successorNeeded: boolean;
  published: string[];
}

export interface BetaPromotionResult {
  state: 'no-op' | 'promoted';
  successorNeeded: boolean;
  successorMode: 'none' | 'reconcile-beta' | 'promote-aliases';
  version?: string;
  digest?: string;
}

export interface BetaRuntime {
  adapter: PublicationAdapter;
  repositories: RegistryRepositories;
  repository: string;
  remote?: string;
  branch?: string;
  expectedTip?: string | undefined;
  cwd?: string;
  changesetReleaseAt?: (ref: string, cwd: string) => ChangesetRelease | null;
}

export function reconcileBetaReleases(
  runtime: BetaRuntime,
): BetaReconcileResult {
  const cwd = runtime.cwd ?? process.cwd();
  const remote = runtime.remote ?? 'origin';
  const branch = runtime.branch ?? 'main';
  const capturedTip = fetchMainAndTags(remote, branch, cwd);
  assertExpectedTip(capturedTip, runtime.expectedTip);
  const stableVersion = packageVersionAt(capturedTip, cwd);
  const stableSemVer = parseSemVer(stableVersion);
  if (stableSemVer.prerelease !== null) {
    throw new Error(
      `Live main package version must be stable, got ${stableVersion}`,
    );
  }

  const stableTag = `v${stableVersion}`;
  fetchTag(stableTag, remote, cwd);
  const tagCommit = resolveStableTagCommit(stableVersion, cwd);
  if (
    tagCommit !== null &&
    (!isAncestor(tagCommit, capturedTip, cwd) ||
      !new Set(firstParentCommits(capturedTip, cwd)).has(tagCommit))
  ) {
    throw new Error(
      `Stable baseline ${stableTag} is not on live main first-parent history`,
    );
  }
  let stablePublicationComplete = false;
  if (tagCommit !== null) {
    stablePublicationComplete =
      publicationComplete(
        {
          identity: {
            channel: 'stable',
            version: stableVersion,
            ref: tagCommit,
          },
          repositories: runtime.repositories,
          repository: runtime.repository,
        },
        runtime.adapter,
      ) !== null;
  }

  const baseline = resolveBaselineReadiness({
    version: stableVersion,
    tagCommit,
    publicationComplete: stablePublicationComplete,
  });
  if (baseline.state === 'deferred') {
    return {
      state: 'deferred',
      baselineVersion: stableVersion,
      capturedTip,
      successorNeeded: false,
      published: [],
    };
  }

  const published: string[] = [];
  const commits = firstParentCommits(`${baseline.ref}..${capturedTip}`, cwd);
  for (const candidate of commits) {
    if (packageVersionAt(candidate, cwd) !== baseline.version) continue;
    const release = releaseIntentAt(runtime, candidate, cwd);
    if (!release) continue;

    const ordinal = firstParentDistance(baseline.ref, candidate, cwd);
    const version = buildBetaVersion(release.newVersion, ordinal);
    const identity: ReleaseIdentity = {
      channel: 'beta',
      version,
      ref: candidate,
    };
    const tag = `v${version}`;
    const remoteTagExists = fetchTag(tag, remote, cwd);
    const existingTag = resolveTagCommit(tag, cwd);
    if (existingTag !== null && existingTag !== candidate) {
      throw new Error(
        `Immutable beta tag ${tag} points to ${existingTag}, expected ${candidate}`,
      );
    }

    reconcilePublication(
      {
        identity,
        repositories: runtime.repositories,
        repository: runtime.repository,
      },
      runtime.adapter,
    );

    if (!remoteTagExists) {
      if (existingTag === null) createAnnotatedTag(tag, candidate, cwd);
      pushTag(tag, remote, cwd);
    }
    const verifiedTag = resolveTagCommit(tag, cwd);
    if (verifiedTag !== candidate) {
      throw new Error(`Beta tag ${tag} failed post-publication verification`);
    }
    published.push(version);
  }

  const finalTip = fetchMainAndTags(remote, branch, cwd);
  return {
    state: 'complete',
    baselineVersion: baseline.version,
    capturedTip,
    successorNeeded: finalTip !== capturedTip,
    published,
  };
}

export function promoteLatestBeta(runtime: BetaRuntime): BetaPromotionResult {
  const cwd = runtime.cwd ?? process.cwd();
  const remote = runtime.remote ?? 'origin';
  const branch = runtime.branch ?? 'main';
  let capturedTip = fetchMainAndTags(remote, branch, cwd);
  assertExpectedTip(capturedTip, runtime.expectedTip);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stableVersion = packageVersionAt(capturedTip, cwd);
    const stableTag = `v${stableVersion}`;
    fetchTag(stableTag, remote, cwd);
    const baselineRef = resolveStableTagCommit(stableVersion, cwd);
    if (baselineRef === null) {
      return {
        state: 'no-op',
        successorNeeded: false,
        successorMode: 'none',
      };
    }
    const selected = selectLatestCompleteBeta(runtime, capturedTip, cwd);
    if (!selected) {
      const finalTip = fetchMainAndTags(remote, branch, cwd);
      return {
        state: 'no-op',
        successorNeeded: finalTip !== capturedTip,
        successorMode: finalTip !== capturedTip ? 'reconcile-beta' : 'none',
      };
    }

    promoteMovingAliases(
      {
        identity: selected.identity,
        repositories: runtime.repositories,
        repository: runtime.repository,
      },
      selected.publication,
      runtime.adapter,
    );

    const finalTip = fetchMainAndTags(remote, branch, cwd);
    if (finalTip !== capturedTip) {
      return {
        state: 'promoted',
        successorNeeded: true,
        successorMode: 'reconcile-beta',
        version: selected.identity.version,
        digest: selected.publication.digest,
      };
    }
    const confirmed = selectLatestCompleteBeta(runtime, finalTip, cwd);
    if (
      confirmed?.identity.version === selected.identity.version &&
      confirmed.identity.ref === selected.identity.ref &&
      confirmed.publication.digest === selected.publication.digest
    ) {
      return {
        state: 'promoted',
        successorNeeded: false,
        successorMode: 'none',
        version: selected.identity.version,
        digest: selected.publication.digest,
      };
    }
    capturedTip = finalTip;
  }

  return {
    state: 'promoted',
    successorNeeded: true,
    successorMode: 'promote-aliases',
  };
}

function selectLatestCompleteBeta(
  runtime: BetaRuntime,
  capturedTip: string,
  cwd: string,
) {
  const firstParentPositions = new Map(
    firstParentCommits(capturedTip, cwd).map((ref, position) => [
      ref,
      position,
    ]),
  );
  let selected:
    | {
        identity: ReleaseIdentity;
        position: number;
        publication: NonNullable<ReturnType<typeof publicationComplete>>;
      }
    | undefined;

  for (const tag of listTags('v*-beta.*', cwd)) {
    const version = tag.slice(1);
    let parsed: ReturnType<typeof parseSemVer>;
    try {
      parsed = parseSemVer(version);
    } catch {
      throw new Error(`Malformed immutable beta tag ${tag}`);
    }
    const match = /^beta\.([1-9]\d*)$/.exec(parsed.prerelease ?? '');
    if (!match) throw new Error(`Malformed immutable beta tag ${tag}`);
    const ordinal = Number(match[1]);
    const ref = resolveTagCommit(tag, cwd);
    if (ref === null) continue;
    const position = firstParentPositions.get(ref);
    if (position === undefined) continue;

    const baselineVersion = packageVersionAt(ref, cwd);
    const baselineRef = resolveStableTagCommit(baselineVersion, cwd);
    const baselinePosition =
      baselineRef === null ? undefined : firstParentPositions.get(baselineRef);
    if (baselinePosition === undefined || baselinePosition >= position) {
      throw new Error(
        `Beta tag ${tag} has no preceding first-parent stable baseline v${baselineVersion}`,
      );
    }
    const distance = position - baselinePosition;
    const release = releaseIntentAt(runtime, ref, cwd);
    if (
      !release ||
      ordinal !== distance ||
      buildBetaVersion(release.newVersion, distance) !== version
    ) {
      throw new Error(
        `Beta tag ${tag} does not match its first-parent candidate metadata`,
      );
    }
    const identity: ReleaseIdentity = { channel: 'beta', version, ref };
    const publication = publicationComplete(
      {
        identity,
        repositories: runtime.repositories,
        repository: runtime.repository,
      },
      runtime.adapter,
    );
    if (!publication) continue;
    if (!selected || position > selected.position) {
      selected = { identity, position, publication };
    }
  }
  return selected;
}

function releaseIntentAt(
  runtime: BetaRuntime,
  ref: string,
  cwd: string,
): ChangesetRelease | null {
  return runtime.changesetReleaseAt?.(ref, cwd) ?? changesetReleaseAt(ref, cwd);
}

export function changesetReleaseAt(ref: string, cwd: string) {
  const cli = resolve(cwd, 'node_modules', '@changesets', 'cli', 'bin.js');
  return withDetachedWorktree(
    ref,
    (worktree) => {
      const temporary = mkdtempSync(
        join(tmpdir(), 'honeybot-changeset-status-'),
      );
      const output = join(temporary, 'status.json');
      try {
        const changesetDirectory = join(worktree, '.changeset');
        if (!existsSync(changesetDirectory)) return null;
        const fragments = readdirSync(changesetDirectory).filter(
          (name) => name.endsWith('.md') && name !== 'README.md',
        );
        if (fragments.length === 0) return null;
        runCommand(process.execPath, [cli, 'status', '--output', output], {
          cwd: worktree,
        });
        const value: unknown = JSON.parse(readFileSync(output, 'utf8'));
        return parseChangesetStatus(value);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
    cwd,
  );
}

function writeOutputs(result: BetaReconcileResult | BetaPromotionResult): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const successorMode =
    'successorMode' in result ? result.successorMode : 'none';
  appendFileSync(
    output,
    `state=${result.state}\nsuccessor-needed=${String(result.successorNeeded)}\nsuccessor-mode=${successorMode}\n`,
  );
}

function parseMode(args: string[]): 'reconcile' | 'promote' {
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  if (mode !== 'reconcile' && mode !== 'promote') {
    throw new Error('Usage: reconcileBetaReleases --mode reconcile|promote');
  }
  return mode;
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const runtime: BetaRuntime = {
    adapter: new DockerBuildxAdapter(),
    repositories: getRepositories(),
    repository,
    expectedTip: process.env.EXPECTED_MAIN_SHA,
  };
  const mode = parseMode(process.argv.slice(2));
  const result =
    mode === 'reconcile'
      ? reconcileBetaReleases(runtime)
      : promoteLatestBeta(runtime);
  writeOutputs(result);
  console.log('Beta release reconciliation completed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `Beta release reconciliation failed: ${describeError(error)}`,
    );
    process.exitCode = 1;
  });
}
