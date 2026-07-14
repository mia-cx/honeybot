import { describe, expect, it } from 'vitest';

import {
  promoteMovingAliases,
  reconcilePublication,
  type BuildRequest,
  type ImageObservation,
  type PublicationAdapter,
} from '../scripts/containerPublication.js';
import {
  releaseLabels,
  type ReleaseIdentity,
} from '../scripts/releaseMetadata.js';

const ref = '0123456789abcdef0123456789abcdef01234567';
const identity: ReleaseIdentity = {
  channel: 'beta',
  version: '1.2.0-beta.3',
  ref,
};
const repositories = {
  ghcr: 'ghcr.io/mia-cx/honeybot',
  dockerhub: 'docker.io/miacx/honeybot',
};
const repository = 'mia-cx/honeybot';
const digest =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('immutable container publication', () => {
  it('builds once and publishes every immutable reference when state is absent', () => {
    const adapter = new FakeAdapter();
    const result = reconcilePublication(
      { identity, repositories, repository },
      adapter,
    );

    expect(result.state).toBe('built');
    expect(adapter.builds).toHaveLength(1);
    expect(adapter.builds[0]?.references).toHaveLength(4);
    expect(adapter.copies).toHaveLength(0);
    expect(
      new Set(
        result.references.map(
          (reference) => adapter.images.get(reference)?.digest,
        ),
      ),
    ).toEqual(new Set([digest]));
  });

  it('repairs partial valid state from one canonical digest without rebuilding', () => {
    const adapter = new FakeAdapter();
    const labels = releaseLabels(identity, repository);
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.2.0-beta.3', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      labels,
    });

    const result = reconcilePublication(
      { identity, repositories, repository },
      adapter,
    );

    expect(result.state).toBe('repaired');
    expect(adapter.builds).toHaveLength(0);
    expect(adapter.copies).toHaveLength(3);
    expect(adapter.copies.every((copy) => copy.digest === digest)).toBe(true);
  });

  it('fails closed on conflicting digests before any write', () => {
    const adapter = new FakeAdapter();
    const labels = releaseLabels(identity, repository);
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.2.0-beta.3', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      labels,
    });
    adapter.images.set('docker.io/miacx/honeybot:v1.2.0-beta.3', {
      reference: 'docker.io/miacx/honeybot:v1.2.0-beta.3',
      digest:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      labels,
    });

    expect(() =>
      reconcilePublication({ identity, repositories, repository }, adapter),
    ).toThrow('Conflicting immutable digests');
    expect(adapter.builds).toHaveLength(0);
    expect(adapter.copies).toHaveLength(0);
  });

  it('fails closed on OCI identity-label conflicts before any write', () => {
    const adapter = new FakeAdapter();
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.2.0-beta.3', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      labels: {
        ...releaseLabels(identity, repository),
        'org.opencontainers.image.revision': 'bad',
      },
    });

    expect(() =>
      reconcilePublication({ identity, repositories, repository }, adapter),
    ).toThrow('Conflicting org.opencontainers.image.revision');
    expect(adapter.builds).toHaveLength(0);
    expect(adapter.copies).toHaveLength(0);
  });

  it('promotes moving beta aliases only from a verified canonical digest', () => {
    const adapter = new FakeAdapter();
    const publication = reconcilePublication(
      { identity, repositories, repository },
      adapter,
    );
    const moving = promoteMovingAliases(
      { identity, repositories, repository },
      publication,
      adapter,
    );

    expect(moving).toContain('ghcr.io/mia-cx/honeybot:beta');
    expect(moving).not.toContain('ghcr.io/mia-cx/honeybot:latest');
    expect(adapter.copies.slice(-moving.length)).toHaveLength(6);
  });
});

class FakeAdapter implements PublicationAdapter {
  readonly images = new Map<string, ImageObservation>();
  readonly builds: BuildRequest[] = [];
  readonly copies: Array<{
    source: string;
    digest: string;
    destination: string;
  }> = [];

  inspect(reference: string): ImageObservation | null {
    return this.images.get(reference) ?? null;
  }

  build(request: BuildRequest): string {
    this.builds.push(request);
    for (const reference of request.references) {
      this.images.set(reference, { reference, digest, labels: request.labels });
    }
    return digest;
  }

  copy(source: string, sourceDigest: string, destination: string): void {
    this.copies.push({ source, digest: sourceDigest, destination });
    const sourceImage = this.images.get(source);
    if (!sourceImage) throw new Error(`Missing fake source ${source}`);
    this.images.set(destination, {
      reference: destination,
      digest: sourceDigest,
      labels: sourceImage.labels,
    });
  }
}
