import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BuildRequest,
  ImageObservation,
  PublicationAdapter,
} from '../scripts/containerPublication.js';
import { promoteLatestBeta } from '../scripts/reconcileBetaReleases.js';
import {
  findStableCandidates,
  reconcileStableReleases,
} from '../scripts/reconcileStableReleases.js';
import {
  imageReferences,
  releaseLabels,
  type ReleaseIdentity,
} from '../scripts/releaseMetadata.js';
import { runGit } from '../scripts/releaseGit.js';

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

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
});

describe('beta alias convergence', () => {
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

  copy(source: string, digest: string, destination: string): void {
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

  copy(source: string): void {
    this.promotedSources.push(source);
    this.newerComplete = true;
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
