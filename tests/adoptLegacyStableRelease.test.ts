import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { adoptLegacyStableRelease } from '../scripts/adoptLegacyStableRelease.js';
import type {
  BuildRequest,
  ImageObservation,
  PublicationAdapter,
} from '../scripts/containerPublication.js';
import { releaseLabels } from '../scripts/releaseMetadata.js';
import { resolveTagCommit, runGit } from '../scripts/releaseGit.js';

const temporaryDirectories: string[] = [];
const repositories = {
  ghcr: 'ghcr.io/mia-cx/honeybot',
  dockerhub: 'docker.io/miacx/honeybot',
};
const legacyDigest =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const targetDigest =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const legacyRevision = '1111111111111111111111111111111111111111';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('guarded legacy stable adoption', () => {
  it('replaces only the expected untagged legacy identity before creating the stable tag', () => {
    const fixture = createRepository();
    const adapter = new LegacyAdapter();
    adapter.addLegacy('ghcr.io/mia-cx/honeybot:v1.0.1');
    adapter.addLegacy('docker.io/miacx/honeybot:v1.0.1');

    const result = adoptLegacyStableRelease(
      {
        version: '1.0.1',
        ref: fixture.ref,
        expectedLegacyDigest: legacyDigest,
        expectedLegacyRevision: legacyRevision,
        repositories,
        repository: 'mia-cx/honeybot',
        cwd: fixture.repository,
      },
      adapter,
    );

    expect(result.digest).toBe(targetDigest);
    expect(resolveTagCommit('v1.0.1', fixture.repository)).toBe(fixture.ref);
    expect(adapter.builds).toHaveLength(1);
    expect(
      adapter.images.get(`ghcr.io/mia-cx/honeybot:sha-${fixture.ref}`)?.digest,
    ).toBe(targetDigest);
    expect(
      adapter.copies.some((copy) => copy.destination.endsWith(':latest')),
    ).toBe(true);
  });

  it('fails before writes when the legacy digest is not explicitly authorized', () => {
    const fixture = createRepository();
    const adapter = new LegacyAdapter();
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.0.1', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.0.1',
      digest:
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      labels: {
        'org.opencontainers.image.version': '1.0.1',
        'org.opencontainers.image.revision': legacyRevision,
      },
    });

    expect(() =>
      adoptLegacyStableRelease(
        {
          version: '1.0.1',
          ref: fixture.ref,
          expectedLegacyDigest: legacyDigest,
          expectedLegacyRevision: legacyRevision,
          repositories,
          repository: 'mia-cx/honeybot',
          cwd: fixture.repository,
        },
        adapter,
      ),
    ).toThrow('not the explicitly authorized legacy identity');
    expect(adapter.builds).toHaveLength(0);
    expect(adapter.copies).toHaveLength(0);
  });

  it('rejects target-identity references with conflicting immutable digests', () => {
    const fixture = createRepository();
    const adapter = new LegacyAdapter();
    const labels = releaseLabels(
      { channel: 'stable', version: '1.0.1', ref: fixture.ref },
      'mia-cx/honeybot',
    );
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.0.1', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.0.1',
      digest: targetDigest,
      labels,
    });
    adapter.images.set('docker.io/miacx/honeybot:v1.0.1', {
      reference: 'docker.io/miacx/honeybot:v1.0.1',
      digest:
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      labels,
    });

    expect(() => adopt(fixture, adapter)).toThrow(
      'conflicting immutable digests',
    );
    expect(adapter.builds).toHaveLength(0);
    expect(adapter.copies).toHaveLength(0);
  });

  it('never reopens legacy replacement after the immutable Git tag exists', () => {
    const fixture = createRepository();
    runGit(['tag', 'v1.0.1', fixture.ref], fixture.repository);
    runGit(['push', 'origin', 'refs/tags/v1.0.1'], fixture.repository);
    const adapter = new LegacyAdapter();
    const labels = releaseLabels(
      { channel: 'stable', version: '1.0.1', ref: fixture.ref },
      'mia-cx/honeybot',
    );
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.0.1', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.0.1',
      digest: targetDigest,
      labels,
    });
    adapter.addLegacy('docker.io/miacx/honeybot:v1.0.1');

    expect(() => adopt(fixture, adapter)).toThrow();
    expect(adapter.builds).toHaveLength(0);
    expect(adapter.copies).toHaveLength(0);
  });
});

class LegacyAdapter implements PublicationAdapter {
  readonly images = new Map<string, ImageObservation>();
  readonly builds: BuildRequest[] = [];
  readonly copies: Array<{
    source: string;
    digest: string;
    destination: string;
  }> = [];

  addLegacy(reference: string): void {
    this.images.set(reference, {
      reference,
      digest: legacyDigest,
      labels: {
        'org.opencontainers.image.version': '1.0.1',
        'org.opencontainers.image.revision': legacyRevision,
      },
    });
  }

  inspect(reference: string): ImageObservation | null {
    return this.images.get(reference) ?? null;
  }

  build(request: BuildRequest): string {
    this.builds.push(request);
    for (const reference of request.references) {
      this.images.set(reference, {
        reference,
        digest: targetDigest,
        labels: request.labels,
      });
    }
    return targetDigest;
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
    this.copies.push({ source, digest, destination });
    const sourceImage = this.images.get(source);
    if (!sourceImage) throw new Error(`Missing source ${source}`);
    this.images.set(destination, {
      reference: destination,
      digest,
      labels: sourceImage.labels,
    });
  }
}

function adopt(
  fixture: { repository: string; ref: string },
  adapter: LegacyAdapter,
) {
  return adoptLegacyStableRelease(
    {
      version: '1.0.1',
      ref: fixture.ref,
      expectedLegacyDigest: legacyDigest,
      expectedLegacyRevision: legacyRevision,
      repositories,
      repository: 'mia-cx/honeybot',
      cwd: fixture.repository,
    },
    adapter,
  );
}

function createRepository(): { repository: string; ref: string } {
  const root = mkdtempSync(join(tmpdir(), 'honeybot-adoption-'));
  temporaryDirectories.push(root);
  const repository = join(root, 'repository');
  const remote = join(root, 'origin.git');
  mkdirSync(repository);
  runGit(['init', '--initial-branch=main'], repository);
  runGit(['config', 'user.name', 'Test Author'], repository);
  runGit(['config', 'user.email', 'test@example.com'], repository);
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'honeybot', version: '1.0.1', private: true }, null, 2)}\n`,
  );
  runGit(['add', 'package.json'], repository);
  runGit(['commit', '--message', 'release 1.0.1'], repository);
  runGit(['init', '--bare', remote], root);
  runGit(['remote', 'add', 'origin', remote], repository);
  runGit(['push', '--set-upstream', 'origin', 'main'], repository);
  return { repository, ref: runGit(['rev-parse', 'HEAD'], repository) };
}
