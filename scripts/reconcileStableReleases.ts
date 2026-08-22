import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DockerBuildxAdapter,
  materializePublicationReference,
  publicationComplete,
  reconcilePublication,
  type PublicationAdapter,
  type PublicationResult,
} from './containerPublication.js';
import {
  compareStableVersions,
  getRepositories,
  imageReferences,
  parseSemVer,
  type RegistryRepositories,
  type ReleaseIdentity,
} from './releaseMetadata.js';
import {
  assertExpectedTip,
  createAnnotatedTag,
  fetchMainAndTags,
  fetchTag,
  firstParentCommits,
  isAncestor,
  listTags,
  packageVersionAt,
  pushTag,
  resolveStableTagCommit,
  resolveTagCommit,
  runCommand,
  runGit,
} from './releaseGit.js';

export interface StableRelease {
  version: string;
  ref: string;
  publication: PublicationResult;
}

export interface StableReconcileResult {
  baselineVersion: string;
  releases: string[];
  latestVersion: string;
}

export interface StableRuntime {
  adapter: PublicationAdapter;
  repositories: RegistryRepositories;
  repository: string;
  allowTagCreation: boolean;
  remote?: string;
  branch?: string;
  expectedTip?: string | undefined;
  cwd?: string;
}

export function reconcileStableReleases(
  runtime: StableRuntime,
): StableReconcileResult {
  const cwd = runtime.cwd ?? process.cwd();
  const remote = runtime.remote ?? 'origin';
  const branch = runtime.branch ?? 'main';
  const tip = fetchMainAndTags(remote, branch, cwd);
  assertExpectedTip(tip, runtime.expectedTip);
  const before = findCompleteStableReleases(runtime, tip);
  const baseline = before[0];
  if (!baseline) {
    throw new Error(
      'No complete stable baseline exists. Run the guarded v1.0.1 adoption before enabling release reconciliation.',
    );
  }

  const reconciled: string[] = [];
  for (const candidate of findStableCandidates(baseline.ref, tip, cwd)) {
    const tag = `v${candidate.version}`;
    const remoteTagExists = fetchTag(tag, remote, cwd);
    const existingTag = resolveTagCommit(tag, cwd);
    if (existingTag !== null && existingTag !== candidate.ref) {
      throw new Error(
        `Stable tag ${tag} peels to ${existingTag}, expected ${candidate.ref}`,
      );
    }
    if (!remoteTagExists) {
      if (!runtime.allowTagCreation) {
        throw new Error(
          `Stable tag ${tag} is absent and this recovery run cannot create tags`,
        );
      }
      if (existingTag === null) createAnnotatedTag(tag, candidate.ref, cwd);
      pushTag(tag, remote, cwd);
    }
    if (resolveTagCommit(tag, cwd) !== candidate.ref) {
      throw new Error(`Stable tag ${tag} failed peeled-target verification`);
    }

    reconcilePublication(
      {
        identity: {
          channel: 'stable',
          version: candidate.version,
          ref: candidate.ref,
        },
        repositories: runtime.repositories,
        repository: runtime.repository,
      },
      runtime.adapter,
    );
    reconciled.push(candidate.version);
  }

  const complete = findCompleteStableReleases(runtime, tip);
  if (complete.length === 0)
    throw new Error('Stable reconciliation produced no complete releases');
  reconcileStableAliases(complete, runtime);

  return {
    baselineVersion: baseline.version,
    releases: reconciled,
    latestVersion: complete.at(-1)?.version ?? baseline.version,
  };
}

export function reconcileStableAliases(
  releases: StableRelease[],
  runtime: StableRuntime,
): string[] {
  const desired = new Map<string, StableRelease>();
  for (const release of releases) {
    const identity: ReleaseIdentity = {
      channel: 'stable',
      version: release.version,
      ref: release.ref,
    };
    for (const alias of imageReferences(identity, runtime.repositories)
      .moving) {
      desired.set(alias, release);
    }
  }

  const updated: string[] = [];
  for (const [alias, release] of desired) {
    if (runtime.adapter.inspect(alias)?.digest === release.publication.digest)
      continue;
    materializePublicationReference(
      release.publication,
      alias,
      runtime.adapter,
    );
    updated.push(alias);
  }
  return updated;
}

export function findStableCandidates(
  baseRef: string,
  tip: string,
  cwd = process.cwd(),
) {
  const candidates: Array<{ version: string; ref: string }> = [];
  for (const commit of firstParentCommits(`${baseRef}..${tip}`, cwd)) {
    const parent = runGit(['rev-parse', `${commit}^1`], cwd);
    const previousVersion = packageVersionAt(parent, cwd);
    const version = packageVersionAt(commit, cwd);
    if (version === previousVersion) continue;

    const parsed = parseSemVer(version);
    if (
      parsed.prerelease !== null ||
      compareStableVersions(previousVersion, version) >= 0
    ) {
      throw new Error(
        `Invalid stable version transition ${previousVersion} -> ${version} at ${commit}`,
      );
    }
    validateStableReleaseCommit(commit, version, cwd);
    candidates.push({ version, ref: commit });
  }
  return candidates;
}

function findCompleteStableReleases(
  runtime: StableRuntime,
  tip: string,
): StableRelease[] {
  const cwd = runtime.cwd ?? process.cwd();
  const releases: StableRelease[] = [];
  const firstParentHistory = new Set(
    runGit(['rev-list', '--first-parent', tip], cwd)
      .split('\n')
      .filter(Boolean),
  );
  for (const tag of listTags('v*.*.*', cwd)) {
    const version = tag.slice(1);
    try {
      if (parseSemVer(version).prerelease !== null) continue;
    } catch {
      continue;
    }
    const ref = resolveStableTagCommit(version, cwd);
    if (
      ref === null ||
      !isAncestor(ref, tip, cwd) ||
      !firstParentHistory.has(ref)
    )
      continue;
    const identity: ReleaseIdentity = { channel: 'stable', version, ref };
    const publication = publicationComplete(
      {
        identity,
        repositories: runtime.repositories,
        repository: runtime.repository,
      },
      runtime.adapter,
    );
    if (publication) releases.push({ version, ref, publication });
  }
  return releases.sort((left, right) =>
    compareStableVersions(left.version, right.version),
  );
}

function validateStableReleaseCommit(
  commit: string,
  version: string,
  cwd: string,
): void {
  const changelog = runCommand('git', ['show', `${commit}:CHANGELOG.md`], {
    cwd,
    allowFailure: true,
  });
  if (
    !new RegExp(`(^|\\s)${escapeRegExp(version)}(\\s|$)`, 'm').test(changelog)
  ) {
    throw new Error(
      `Stable transition ${version} at ${commit} is missing its CHANGELOG entry`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeOutputs(result: StableReconcileResult): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(
    output,
    `baseline-version=${result.baselineVersion}\nlatest-version=${result.latestVersion}\nreleases=${JSON.stringify(result.releases)}\n`,
  );
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const result = reconcileStableReleases({
    adapter: new DockerBuildxAdapter(),
    repositories: getRepositories(),
    repository,
    allowTagCreation: !process.argv.includes('--existing-tags-only'),
    expectedTip: process.env.EXPECTED_MAIN_SHA,
  });
  writeOutputs(result);
  console.log('Stable release reconciliation completed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Stable release reconciliation failed.');
    process.exitCode = 1;
  });
}
