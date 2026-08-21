import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BuildRequest,
  ImageObservation,
  PublicationAdapter,
} from '../scripts/containerPublication.js';
import {
  changesetReleaseAt,
  promoteLatestBeta,
  reconcileBetaReleases,
} from '../scripts/reconcileBetaReleases.js';
import {
  findStableCandidates,
  reconcileStableReleases,
} from '../scripts/reconcileStableReleases.js';
import {
  imageReferences,
  releaseLabels,
  type ReleaseIdentity,
} from '../scripts/releaseMetadata.js';
import { resolveTagCommit, runGit } from '../scripts/releaseGit.js';

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('workflow dispatch routing', () => {
  it('routes every checkout-independent workflow dispatch explicitly', () => {
    for (const workflowPath of [
      '.github/workflows/container.yml',
      '.github/workflows/release.yml',
    ]) {
      const workflow = readFileSync(join(process.cwd(), workflowPath), 'utf8');
      const dispatchSteps = workflow
        .split(/\n(?= {6}- name: )/)
        .filter((step) => step.includes('run: gh workflow run'));
      expect(dispatchSteps.length).toBeGreaterThan(0);
      for (const step of dispatchSteps) {
        expect(step).toContain('GH_REPO: ${{ github.repository }}');
      }
    }
  });

  it('parses workflow job boundaries with CRLF line endings', () => {
    const workflow = [
      'jobs:',
      '  version:',
      '    if: trusted',
      '    runs-on: ubuntu-latest',
      '  stable:',
      '    if: trusted',
    ].join('\r\n');

    expect(workflowJob(workflow, 'version')).toContain('    if: trusted');
  });

  it('keeps privileged manual dispatch jobs on the trusted main ref', () => {
    const expectations = [
      {
        workflow: '.github/workflows/container.yml',
        job: 'reconcile',
        predicates: [
          "github.event_name == 'push'",
          "github.event_name == 'workflow_dispatch'",
          "github.ref == 'refs/heads/main'",
          "inputs.mode == 'reconcile-beta'",
        ],
      },
      {
        workflow: '.github/workflows/container.yml',
        job: 'promote',
        predicates: [
          "needs.reconcile.result == 'success'",
          "github.event_name == 'workflow_dispatch'",
          "github.ref == 'refs/heads/main'",
          "inputs.mode == 'promote-aliases'",
        ],
      },
      {
        workflow: '.github/workflows/release.yml',
        job: 'version',
        predicates: [
          "github.event_name == 'workflow_dispatch'",
          "github.ref == 'refs/heads/main'",
          "inputs.mode == 'update-version-pr'",
        ],
      },
      {
        workflow: '.github/workflows/release.yml',
        job: 'stable',
        predicates: [
          "github.event_name == 'push'",
          "github.event_name == 'workflow_dispatch'",
          "github.ref == 'refs/heads/main'",
          "inputs.mode == 'reconcile-stable'",
        ],
      },
      {
        workflow: '.github/workflows/release.yml',
        job: 'adopt-legacy',
        predicates: [
          "github.event_name == 'workflow_dispatch'",
          "github.ref == 'refs/heads/main'",
          "inputs.mode == 'adopt-v1.0.1'",
        ],
      },
    ];

    for (const expectation of expectations) {
      const workflow = readFileSync(
        join(process.cwd(), expectation.workflow),
        'utf8',
      );
      const job = workflowJob(workflow, expectation.job);
      for (const predicate of expectation.predicates) {
        expect(job).toContain(predicate);
      }
    }
  });

  it('gates credential-writing jobs and rejects stale approved revisions', () => {
    const expectations = [
      ['.github/workflows/container.yml', 'reconcile'],
      ['.github/workflows/container.yml', 'promote'],
      ['.github/workflows/release.yml', 'version'],
      ['.github/workflows/release.yml', 'stable'],
      ['.github/workflows/release.yml', 'adopt-legacy'],
    ] as const;

    for (const [workflowPath, jobName] of expectations) {
      const workflow = readFileSync(join(process.cwd(), workflowPath), 'utf8');
      const job = workflowJob(workflow, jobName);
      expect(job).toContain('environment: stable-release');
      expect(job).toContain('ref: ${{ github.sha }}');
      expect(job).toContain('persist-credentials: false');
      expect(job).toContain('Verify approved revision is still live main');
      expect(job).toContain(
        'refs/heads/main:refs/remotes/origin/main',
      );
      expect(job).toContain(
        'git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)',
      );
    }
  });

  it('creates and exposes the release App token only after trusted setup', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github/workflows/release.yml'),
      'utf8',
    );
    const job = workflowJob(workflow, 'version');
    const install = job.indexOf('name: Install dependencies');
    const liveMainCheck = job.indexOf(
      'name: Verify approved revision is still live main',
    );
    const createToken = job.indexOf('name: Create release automation token');
    const changesets = job.indexOf('name: Create version pull request');

    expect(install).toBeGreaterThan(-1);
    expect(liveMainCheck).toBeGreaterThan(install);
    expect(createToken).toBeGreaterThan(liveMainCheck);
    expect(changesets).toBeGreaterThan(createToken);
    expect(job).not.toContain('persist-credentials: true');
    expect(job).not.toContain('token: ${{ steps.release-token.outputs.token }}');
    expect(job).toContain('credential.helper');
    expect(job).toContain('password=$GITHUB_TOKEN');
    expect(job).toContain('Remove App Git authentication helper');
  });

  it('schedules state recovery after an interrupted beta run', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github/workflows/container.yml'),
      'utf8',
    );

    expect(workflow).toContain("cron: '17 * * * *'");
    expect(workflowJob(workflow, 'reconcile')).toContain(
      "github.event_name == 'schedule'",
    );
  });
});

function workflowJob(workflow: string, jobName: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${jobName}:`);
  if (start < 0) throw new Error(`Workflow job ${jobName} is missing`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n');
}

describe('stable release discovery', () => {
  it('finds Changesets version transitions at their exact first-parent commit', () => {
    const repository = createRepository();
    const baseline = runGit(['rev-parse', 'HEAD'], repository);

    writePackage(repository, '1.0.1');
    writeFileSync(join(repository, 'ordinary.txt'), 'ordinary\n');
    runGit(['add', '.'], repository);
    runGit(['commit', '--message', 'ordinary integration'], repository);

    writePackage(repository, '1.1.0');
    writeFileSync(
      join(repository, 'CHANGELOG.md'),
      '# honeybot\n\n## 1.1.0\n\n### Minor Changes\n',
    );
    rmSync(join(repository, '.changeset', 'feature.md'));
    runGit(['add', '--all'], repository);
    runGit(
      ['commit', '--message', 'chore(release): version packages'],
      repository,
    );
    const releaseCommit = runGit(['rev-parse', 'HEAD'], repository);

    writeFileSync(join(repository, 'later.txt'), 'later\n');
    runGit(['add', '.'], repository);
    runGit(['commit', '--message', 'later integration'], repository);
    const tip = runGit(['rev-parse', 'HEAD'], repository);

    expect(findStableCandidates(baseline, tip, repository)).toEqual([
      { version: '1.1.0', ref: releaseCommit },
    ]);
  });

  it('rejects a manual version bump without consumed Changesets', () => {
    const repository = createRepository();
    const baseline = runGit(['rev-parse', 'HEAD'], repository);
    writePackage(repository, '1.1.0');
    writeFileSync(join(repository, 'CHANGELOG.md'), '# honeybot\n\n## 1.1.0\n');
    runGit(['add', '.'], repository);
    runGit(['commit', '--message', 'manual version bump'], repository);
    const tip = runGit(['rev-parse', 'HEAD'], repository);

    expect(() => findStableCandidates(baseline, tip, repository)).toThrow(
      'consumed no Changeset fragments',
    );
  });

  it('does not let a later complete release hide an earlier incomplete transition', () => {
    const fixture = createStableGapRepository();
    const adapter = new StableGapAdapter(fixture);

    const result = reconcileStableReleases({
      adapter,
      repositories: fixture.repositories,
      repository: 'mia-cx/honeybot',
      allowTagCreation: false,
      cwd: fixture.repository,
    });

    expect(result.releases).toContain('1.1.0');
    expect(adapter.builds.map((build) => build.identity.version)).toContain(
      '1.1.0',
    );
    const sharedAliasWrites = adapter.copies.filter(
      (copy) =>
        copy.destination.endsWith(':latest') ||
        copy.destination.endsWith(':v1'),
    );
    expect(sharedAliasWrites).toHaveLength(4);
    expect(
      sharedAliasWrites.every((copy) => copy.source.includes(':v1.2.0')),
    ).toBe(true);
  });

  it('creates a missing stable tag without installing historical dependencies', () => {
    const fixture = createStableGapRepository();
    runGit(['tag', '--delete', 'v1.1.0'], fixture.repository);
    runGit(['push', 'origin', '--delete', 'v1.1.0'], fixture.repository);
    const adapter = new StableGapAdapter(fixture);

    reconcileStableReleases({
      adapter,
      repositories: fixture.repositories,
      repository: 'mia-cx/honeybot',
      allowTagCreation: true,
      cwd: fixture.repository,
    });

    expect(resolveTagCommit('v1.1.0', fixture.repository)).toBe(fixture.middle);
  });
});

describe('beta alias convergence', () => {
  it('treats a commit with no pending Changeset fragments as no release intent', () => {
    const repository = createRepository();
    rmSync(join(repository, '.changeset', 'feature.md'));
    runGit(['add', '--all'], repository);
    runGit(['commit', '--message', 'consume release intent'], repository);
    const ref = runGit(['rev-parse', 'HEAD'], repository);

    expect(changesetReleaseAt(ref, repository)).toBeNull();
  });

  it('rejects a stable beta baseline outside main first-parent history', () => {
    const fixture = createBetaRepository();
    runGit(['tag', '--delete', 'v1.0.0'], fixture.repository);
    runGit(['tag', 'v1.0.0', fixture.side], fixture.repository);
    runGit(
      ['push', '--force', 'origin', 'refs/tags/v1.0.0'],
      fixture.repository,
    );
    const adapter = new AliasRepairAdapter(fixture.repositories, [
      { channel: 'stable', version: '1.0.0', ref: fixture.side },
    ]);

    expect(() =>
      reconcileBetaReleases({
        adapter,
        repositories: fixture.repositories,
        repository: 'mia-cx/honeybot',
        cwd: fixture.repository,
        changesetReleaseAt: () => ({
          name: 'honeybot',
          type: 'minor',
          oldVersion: '1.0.0',
          newVersion: '1.1.0',
        }),
      }),
    ).toThrow('not on live main first-parent history');
  });

  it('repairs aliases from the previous beta epoch after its stable release', () => {
    const fixture = createBetaRepository();
    advanceBetaFixtureToStable(fixture);
    const identity: ReleaseIdentity = {
      channel: 'beta',
      version: '1.1.0-beta.2',
      ref: fixture.second,
    };
    const adapter = new AliasRepairAdapter(fixture.repositories, [identity]);

    const result = promoteLatestBeta({
      adapter,
      repositories: fixture.repositories,
      repository: 'mia-cx/honeybot',
      cwd: fixture.repository,
      changesetReleaseAt: () => ({
        name: 'honeybot',
        type: 'minor',
        oldVersion: '1.0.0',
        newVersion: '1.1.0',
      }),
    });

    expect(result).toMatchObject({
      state: 'promoted',
      version: identity.version,
      successorNeeded: false,
    });
    expect(adapter.promotedSources).not.toHaveLength(0);
    expect(adapter.promotedSources.every((source) => source.includes(':v1.1.0-beta.2'))).toBe(true);
  });

  it('prefers a newer beta epoch even when its ordinal is lower', () => {
    const fixture = createBetaRepository();
    advanceBetaFixtureToStable(fixture);
    writeFileSync(join(fixture.repository, 'next-beta.txt'), 'next beta\n');
    runGit(['add', '.'], fixture.repository);
    runGit(['commit', '--message', 'next beta integration'], fixture.repository);
    const next = runGit(['rev-parse', 'HEAD'], fixture.repository);
    runGit(['tag', 'v1.2.0-beta.1', next], fixture.repository);
    runGit(['push', 'origin', 'main', '--tags'], fixture.repository);

    const identities: ReleaseIdentity[] = [
      {
        channel: 'beta',
        version: '1.1.0-beta.2',
        ref: fixture.second,
      },
      { channel: 'beta', version: '1.2.0-beta.1', ref: next },
    ];
    const adapter = new AliasRepairAdapter(fixture.repositories, identities);

    const result = promoteLatestBeta({
      adapter,
      repositories: fixture.repositories,
      repository: 'mia-cx/honeybot',
      cwd: fixture.repository,
      changesetReleaseAt: (ref) => ({
        name: 'honeybot',
        type: 'minor',
        oldVersion: ref === next ? '1.1.0' : '1.0.0',
        newVersion: ref === next ? '1.2.0' : '1.1.0',
      }),
    });

    expect(result).toMatchObject({
      state: 'promoted',
      version: '1.2.0-beta.1',
      successorNeeded: false,
    });
    expect(adapter.promotedSources.every((source) => source.includes(':v1.2.0-beta.1'))).toBe(true);
  });

  it('reselects complete beta state at the same main tip until aliases stabilize', () => {
    const fixture = createBetaRepository();
    const adapter = new PromotionAdapter(fixture);

    const result = promoteLatestBeta({
      adapter,
      repositories: fixture.repositories,
      repository: 'mia-cx/honeybot',
      cwd: fixture.repository,
      changesetReleaseAt: () => ({
        name: 'honeybot',
        type: 'minor',
        oldVersion: '1.0.0',
        newVersion: '1.1.0',
      }),
    });

    expect(result).toMatchObject({
      state: 'promoted',
      version: '1.1.0-beta.2',
      successorNeeded: false,
      successorMode: 'none',
    });
    expect(adapter.promotedSources.at(-1)).toContain(':v1.1.0-beta.2');
  });
});

class StableGapAdapter implements PublicationAdapter {
  readonly images = new Map<string, ImageObservation>();
  readonly builds: BuildRequest[] = [];
  readonly copies: Array<{ source: string; destination: string }> = [];

  constructor(
    private readonly fixture: ReturnType<typeof createStableGapRepository>,
  ) {
    this.addComplete('1.0.0', fixture.baseline, 'a');
    this.addComplete('1.2.0', fixture.latest, 'c');
  }

  inspect(reference: string): ImageObservation | null {
    return this.images.get(reference) ?? null;
  }

  build(request: BuildRequest): string {
    this.builds.push(request);
    const digest = `sha256:${'b'.repeat(64)}`;
    for (const reference of request.references) {
      this.images.set(reference, { reference, digest, labels: request.labels });
    }
    return digest;
  }

  retag(source: string, digest: string, destination: string): void {
    this.materialize(source, digest, destination);
  }

  transfer(source: string, digest: string, destination: string): void {
    this.materialize(source, digest, destination);
  }

  private materialize(
    source: string,
    digest: string,
    destination: string,
  ): void {
    this.copies.push({ source, destination });
    const image = this.images.get(source);
    if (!image) throw new Error(`Missing source ${source}`);
    this.images.set(destination, {
      reference: destination,
      digest,
      labels: image.labels,
    });
  }

  private addComplete(
    version: string,
    ref: string,
    digestCharacter: string,
  ): void {
    const identity: ReleaseIdentity = { channel: 'stable', version, ref };
    const digest = `sha256:${digestCharacter.repeat(64)}`;
    const labels = releaseLabels(identity, 'mia-cx/honeybot');
    for (const reference of imageReferences(identity, this.fixture.repositories)
      .immutable) {
      this.images.set(reference, { reference, digest, labels });
    }
  }
}

class AliasRepairAdapter implements PublicationAdapter {
  readonly promotedSources: string[] = [];
  private readonly images = new Map<string, ImageObservation>();

  constructor(
    repositories: Parameters<typeof imageReferences>[1],
    identities: ReleaseIdentity[],
  ) {
    for (const [index, identity] of identities.entries()) {
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      const labels = releaseLabels(identity, 'mia-cx/honeybot');
      for (const reference of imageReferences(identity, repositories).immutable) {
        this.images.set(reference, { reference, digest, labels });
      }
    }
  }

  inspect(reference: string): ImageObservation | null {
    return this.images.get(reference) ?? null;
  }

  build(): string {
    throw new Error('alias repair test must not build');
  }

  retag(source: string, digest: string, destination: string): void {
    const image = this.images.get(source);
    if (!image || image.digest !== digest) {
      throw new Error(`Missing immutable source ${source}@${digest}`);
    }
    this.promotedSources.push(source);
    this.images.set(destination, { ...image, reference: destination });
  }

  transfer(): void {
    throw new Error('alias repair must use registry-local retags');
  }
}

class PromotionAdapter implements PublicationAdapter {
  readonly promotedSources: string[] = [];
  private newerComplete = false;

  constructor(
    private readonly fixture: ReturnType<typeof createBetaRepository>,
  ) {}

  inspect(reference: string): ImageObservation | null {
    const stable = this.observationFor(
      { channel: 'stable', version: '1.0.0', ref: this.fixture.baseline },
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reference,
    );
    if (stable) return stable;
    const first = this.observationFor(
      { channel: 'beta', version: '1.1.0-beta.1', ref: this.fixture.first },
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reference,
    );
    if (first) return first;
    const sideBranch = this.observationFor(
      { channel: 'beta', version: '1.1.0-beta.99', ref: this.fixture.side },
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      reference,
    );
    if (sideBranch) return sideBranch;
    if (!this.newerComplete) return null;
    return this.observationFor(
      { channel: 'beta', version: '1.1.0-beta.2', ref: this.fixture.second },
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      reference,
    );
  }

  build(): string {
    throw new Error('promotion test must not build');
  }

  retag(source: string): void {
    this.promotedSources.push(source);
    this.newerComplete = true;
  }

  transfer(): void {
    throw new Error(
      'complete publication aliases must use registry-local retags',
    );
  }

  private observationFor(
    identity: ReleaseIdentity,
    digest: string,
    reference: string,
  ): ImageObservation | null {
    const immutable = imageReferences(
      identity,
      this.fixture.repositories,
    ).immutable;
    if (!immutable.includes(reference)) return null;
    return {
      reference,
      digest,
      labels: releaseLabels(identity, 'mia-cx/honeybot'),
    };
  }
}

function createStableGapRepository() {
  const root = mkdtempSync(join(tmpdir(), 'honeybot-stable-gap-'));
  repositories.push(root);
  const repository = join(root, 'repository');
  const remote = join(root, 'origin.git');
  mkdirSync(repository);
  runGit(['init', '--initial-branch=main'], repository);
  runGit(['config', 'user.name', 'Test Author'], repository);
  runGit(['config', 'user.email', 'test@example.com'], repository);
  writePackage(repository, '1.0.0');
  writeFileSync(join(repository, 'CHANGELOG.md'), '# honeybot\n\n## 1.0.0\n');
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'stable 1.0.0'], repository);
  const baseline = runGit(['rev-parse', 'HEAD'], repository);

  mkdirSync(join(repository, '.changeset'));
  writeFileSync(
    join(repository, '.changeset', 'one.md'),
    '---\n"honeybot": minor\n---\n',
  );
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'feature one'], repository);
  writePackage(repository, '1.1.0');
  writeFileSync(
    join(repository, 'CHANGELOG.md'),
    '# honeybot\n\n## 1.1.0\n\n## 1.0.0\n',
  );
  rmSync(join(repository, '.changeset', 'one.md'));
  runGit(['add', '--all'], repository);
  runGit(['commit', '--message', 'release 1.1.0'], repository);
  const middle = runGit(['rev-parse', 'HEAD'], repository);

  writeFileSync(
    join(repository, '.changeset', 'two.md'),
    '---\n"honeybot": minor\n---\n',
  );
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'feature two'], repository);
  writePackage(repository, '1.2.0');
  writeFileSync(
    join(repository, 'CHANGELOG.md'),
    '# honeybot\n\n## 1.2.0\n\n## 1.1.0\n\n## 1.0.0\n',
  );
  rmSync(join(repository, '.changeset', 'two.md'));
  runGit(['add', '--all'], repository);
  runGit(['commit', '--message', 'release 1.2.0'], repository);
  const latest = runGit(['rev-parse', 'HEAD'], repository);

  runGit(['tag', 'v1.0.0', baseline], repository);
  runGit(['tag', 'v1.1.0', middle], repository);
  runGit(['tag', 'v1.2.0', latest], repository);
  runGit(['init', '--bare', remote], root);
  runGit(['remote', 'add', 'origin', remote], repository);
  runGit(['push', '--set-upstream', 'origin', 'main', '--tags'], repository);

  return {
    repository,
    baseline,
    middle,
    latest,
    repositories: {
      ghcr: 'ghcr.io/mia-cx/honeybot',
      dockerhub: 'docker.io/miacx/honeybot',
    },
  };
}

function advanceBetaFixtureToStable(
  fixture: ReturnType<typeof createBetaRepository>,
): void {
  writePackage(fixture.repository, '1.1.0');
  runGit(['add', 'package.json'], fixture.repository);
  runGit(['commit', '--message', 'stable 1.1.0'], fixture.repository);
  runGit(['tag', 'v1.1.0'], fixture.repository);
  runGit(['push', 'origin', 'main', '--tags'], fixture.repository);
}

function createBetaRepository() {
  const root = mkdtempSync(join(tmpdir(), 'honeybot-beta-history-'));
  repositories.push(root);
  const repository = join(root, 'repository');
  const remote = join(root, 'origin.git');
  mkdirSync(repository);
  runGit(['init', '--initial-branch=main'], repository);
  runGit(['config', 'user.name', 'Test Author'], repository);
  runGit(['config', 'user.email', 'test@example.com'], repository);
  writePackage(repository, '1.0.0');
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'stable baseline'], repository);
  const baseline = runGit(['rev-parse', 'HEAD'], repository);

  runGit(['checkout', '-b', 'side'], repository);
  writeFileSync(join(repository, 'side.txt'), 'side\n');
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'side branch candidate'], repository);
  const side = runGit(['rev-parse', 'HEAD'], repository);
  runGit(['tag', 'v1.1.0-beta.99', side], repository);
  runGit(['checkout', 'main'], repository);

  writeFileSync(join(repository, 'first.txt'), 'first\n');
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'first beta integration'], repository);
  const first = runGit(['rev-parse', 'HEAD'], repository);

  writeFileSync(join(repository, 'second.txt'), 'second\n');
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'second beta integration'], repository);
  const second = runGit(['rev-parse', 'HEAD'], repository);
  runGit(
    ['merge', '--no-ff', 'side', '--message', 'merge side branch'],
    repository,
  );

  runGit(['tag', 'v1.0.0', baseline], repository);
  runGit(['tag', 'v1.1.0-beta.1', first], repository);
  runGit(['tag', 'v1.1.0-beta.2', second], repository);
  runGit(['init', '--bare', remote], root);
  runGit(['remote', 'add', 'origin', remote], repository);
  runGit(['push', '--set-upstream', 'origin', 'main', '--tags'], repository);

  return {
    repository,
    baseline,
    first,
    second,
    side,
    repositories: {
      ghcr: 'ghcr.io/mia-cx/honeybot',
      dockerhub: 'docker.io/miacx/honeybot',
    },
  };
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'honeybot-stable-history-'));
  repositories.push(repository);
  runGit(['init', '--initial-branch=main'], repository);
  runGit(['config', 'user.name', 'Test Author'], repository);
  runGit(['config', 'user.email', 'test@example.com'], repository);
  mkdirSync(join(repository, '.changeset'));
  writePackage(repository, '1.0.1');
  writeFileSync(
    join(repository, '.changeset', 'feature.md'),
    '---\n"honeybot": minor\n---\n\nFeature\n',
  );
  writeFileSync(join(repository, 'CHANGELOG.md'), '# honeybot\n\n## 1.0.1\n');
  runGit(['add', '.'], repository);
  runGit(['commit', '--message', 'baseline'], repository);
  return repository;
}

function writePackage(repository: string, version: string): void {
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'honeybot', version, private: true }, null, 2)}\n`,
  );
}
