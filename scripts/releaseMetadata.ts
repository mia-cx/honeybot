export type ReleaseChannel = 'beta' | 'stable';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export interface RegistryRepositories {
  ghcr: string;
  dockerhub: string;
}

export interface ImageReferences {
  exact: string[];
  sha: string[];
  immutable: string[];
  moving: string[];
}

export interface ReleaseIdentity {
  channel: ReleaseChannel;
  version: string;
  ref: string;
}

export interface ChangesetRelease {
  name: string;
  type: string;
  oldVersion: string;
  newVersion: string;
  changesets?: string[];
}

export interface ChangesetStatus {
  releases: ChangesetRelease[];
}

export type BaselineReadiness =
  | {
      state: 'ready';
      version: string;
      tag: string;
      ref: string;
    }
  | {
      state: 'deferred';
      version: string;
      reason: 'missing-tag' | 'incomplete-publication';
    };

export interface BetaCommitSnapshot {
  ref: string;
  ordinal: number;
  nextVersion: string | null;
  stableTransition: boolean;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function parseSemVer(version: string): SemVer {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (a.prerelease !== null || b.prerelease !== null) {
    throw new Error('Stable version comparison does not accept prereleases');
  }

  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function requireFullCommitSha(ref: string): string {
  if (!FULL_SHA_PATTERN.test(ref)) {
    throw new Error(
      `Expected a full 40-character lowercase commit SHA, got: ${ref}`,
    );
  }
  return ref;
}

export function validateReleaseIdentity(
  identity: ReleaseIdentity,
): ReleaseIdentity {
  requireFullCommitSha(identity.ref);
  const version = parseSemVer(identity.version);

  if (identity.channel === 'stable' && version.prerelease !== null) {
    throw new Error(
      `Stable publication cannot use prerelease version ${identity.version}`,
    );
  }
  if (
    identity.channel === 'beta' &&
    !/^beta\.[1-9]\d*$/.test(version.prerelease ?? '')
  ) {
    throw new Error(
      `Beta publication requires a beta.N version, got ${identity.version}`,
    );
  }
  return identity;
}

export function buildBetaVersion(
  nextStableVersion: string,
  ordinal: number,
): string {
  const next = parseSemVer(nextStableVersion);
  if (next.prerelease !== null) {
    throw new Error(
      `Next stable version must not be a prerelease: ${nextStableVersion}`,
    );
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error(`Beta ordinal must be a positive integer, got ${ordinal}`);
  }
  return `${nextStableVersion}-beta.${ordinal}`;
}

export function parseChangesetStatus(
  value: unknown,
  packageName = 'honeybot',
): ChangesetRelease | null {
  if (!isRecord(value) || !Array.isArray(value.releases)) {
    throw new Error('Changesets status must contain a releases array');
  }

  const releases = value.releases.map(parseChangesetRelease);
  const unexpected = releases.filter((release) => release.name !== packageName);
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected package release(s): ${unexpected.map((release) => release.name).join(', ')}`,
    );
  }
  if (releases.length > 1) {
    throw new Error(
      `Expected at most one ${packageName} release, got ${releases.length}`,
    );
  }
  return releases[0] ?? null;
}

export function imageReferences(
  identity: ReleaseIdentity,
  repositories: RegistryRepositories,
): ImageReferences {
  validateReleaseIdentity(identity);
  const version = parseSemVer(identity.version);
  const exactSuffix = `v${identity.version}`;
  const shaSuffix = `sha-${identity.ref}`;
  const exact = bothRegistries(repositories, exactSuffix);
  const sha = bothRegistries(repositories, shaSuffix);

  const movingSuffixes =
    identity.channel === 'beta'
      ? [
          `v${version.major}.${version.minor}-beta`,
          `v${version.major}-beta`,
          'beta',
        ]
      : [`v${version.major}.${version.minor}`, `v${version.major}`, 'latest'];

  return {
    exact,
    sha,
    immutable: [...exact, ...sha],
    moving: movingSuffixes.flatMap((suffix) =>
      bothRegistries(repositories, suffix),
    ),
  };
}

export function releaseLabels(
  identity: ReleaseIdentity,
  repository: string,
): Record<string, string> {
  validateReleaseIdentity(identity);
  return {
    'org.opencontainers.image.title': 'honeybot',
    'org.opencontainers.image.description':
      'Discord moderation bot for honeypot and scam raid detection',
    'org.opencontainers.image.source': `https://github.com/${repository}`,
    'org.opencontainers.image.revision': identity.ref,
    'org.opencontainers.image.version': identity.version,
  };
}

export function resolveBaselineReadiness(input: {
  version: string;
  tagCommit: string | null;
  publicationComplete: boolean;
}): BaselineReadiness {
  const parsed = parseSemVer(input.version);
  if (parsed.prerelease !== null) {
    throw new Error(`Stable baseline cannot be a prerelease: ${input.version}`);
  }
  if (input.tagCommit === null) {
    return { state: 'deferred', version: input.version, reason: 'missing-tag' };
  }
  requireFullCommitSha(input.tagCommit);
  if (!input.publicationComplete) {
    return {
      state: 'deferred',
      version: input.version,
      reason: 'incomplete-publication',
    };
  }
  return {
    state: 'ready',
    version: input.version,
    tag: `v${input.version}`,
    ref: input.tagCommit,
  };
}

export function selectEligibleBetaCommits(
  snapshots: BetaCommitSnapshot[],
): BetaCommitSnapshot[] {
  return snapshots.filter(
    (snapshot) =>
      !snapshot.stableTransition &&
      snapshot.nextVersion !== null &&
      snapshot.ordinal > 0,
  );
}

export function getRepositories(
  environment: NodeJS.ProcessEnv = process.env,
): RegistryRepositories {
  const githubRepository = environment.GITHUB_REPOSITORY;
  const dockerhubUsername = environment.DOCKERHUB_USERNAME;
  const dockerhubRepository = environment.DOCKERHUB_REPOSITORY ?? 'honeybot';
  if (!githubRepository) throw new Error('GITHUB_REPOSITORY is required');
  if (!dockerhubUsername) throw new Error('DOCKERHUB_USERNAME is required');

  return {
    ghcr: `ghcr.io/${githubRepository}`,
    dockerhub: `docker.io/${dockerhubUsername}/${dockerhubRepository}`,
  };
}

function bothRegistries(
  repositories: RegistryRepositories,
  suffix: string,
): string[] {
  return [
    `${repositories.ghcr}:${suffix}`,
    `${repositories.dockerhub}:${suffix}`,
  ];
}

function parseChangesetRelease(value: unknown): ChangesetRelease {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.oldVersion !== 'string' ||
    typeof value.newVersion !== 'string'
  ) {
    throw new Error('Invalid Changesets release record');
  }

  parseSemVer(value.oldVersion);
  parseSemVer(value.newVersion);
  return {
    name: value.name,
    type: value.type,
    oldVersion: value.oldVersion,
    newVersion: value.newVersion,
    ...(Array.isArray(value.changesets)
      ? {
          changesets: value.changesets.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
