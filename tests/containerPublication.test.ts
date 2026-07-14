import { describe, expect, it } from 'vitest';

import {
  DockerBuildxAdapter,
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

describe('registry publication adapter', () => {
  it('uses a real registry transfer for cross-registry copies', () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const adapter = new DockerBuildxAdapter((command, args) => {
      commands.push({ command, args });
      return '';
    });

    adapter.transfer(
      'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      'docker.io/miacx/honeybot:v1.2.0-beta.3',
    );

    expect(commands).toEqual([
      {
        command: 'crane',
        args: [
          'copy',
          `ghcr.io/mia-cx/honeybot@${digest}`,
          'docker.io/miacx/honeybot:v1.2.0-beta.3',
        ],
      },
    ]);
  });

  it('uses Buildx only for registry-local retags', () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const adapter = new DockerBuildxAdapter((command, args) => {
      commands.push({ command, args });
      return '';
    });

    adapter.retag(
      'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      'ghcr.io/mia-cx/honeybot:beta',
    );

    expect(commands).toEqual([
      {
        command: 'docker',
        args: [
          'buildx',
          'imagetools',
          'create',
          '--tag',
          'ghcr.io/mia-cx/honeybot:beta',
          `ghcr.io/mia-cx/honeybot@${digest}`,
        ],
      },
    ]);
    expect(() =>
      adapter.retag(
        'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
        digest,
        'docker.io/miacx/honeybot:beta',
      ),
    ).toThrow('same-registry operation rejected');
  });

  it('observes a structurally valid image with no OCI labels', () => {
    const adapter = new DockerBuildxAdapter(() =>
      JSON.stringify({
        manifest: { digest },
        image: {
          'linux/amd64': { config: {} },
        },
      }),
    );

    expect(
      adapter.inspect('docker.io/miacx/honeybot:v1.0.1'),
    ).toEqual({
      reference: 'docker.io/miacx/honeybot:v1.0.1',
      digest,
      labels: {},
    });
  });
});

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
    expect(adapter.operations).toHaveLength(0);
    expect(
      new Set(
        result.references.map(
          (reference) => adapter.images.get(reference)?.digest,
        ),
      ),
    ).toEqual(new Set([digest]));
  });

  it.each([
    'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
    'docker.io/miacx/honeybot:v1.2.0-beta.3',
  ])(
    'repairs partial valid state from %s without rebuilding',
    (existingReference) => {
      const adapter = new FakeAdapter();
      const labels = releaseLabels(identity, repository);
      adapter.images.set(existingReference, {
        reference: existingReference,
        digest,
        labels,
      });

      const result = reconcilePublication(
        { identity, repositories, repository },
        adapter,
      );

      expect(result.state).toBe('repaired');
      expect(adapter.builds).toHaveLength(0);
      expect(adapter.operations).toHaveLength(3);
      expect(adapter.operations.every((copy) => copy.digest === digest)).toBe(
        true,
      );
      expect(adapter.operations.map((operation) => operation.kind)).toEqual([
        'transfer',
        'retag',
        'retag',
      ]);
    },
  );

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
    expect(adapter.operations).toHaveLength(0);
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
    expect(adapter.operations).toHaveLength(0);
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
    const promotions = adapter.operations.slice(-moving.length);
    expect(promotions).toHaveLength(6);
    expect(promotions.every((operation) => operation.kind === 'retag')).toBe(
      true,
    );
  });
});

class FakeAdapter implements PublicationAdapter {
  readonly images = new Map<string, ImageObservation>();
  readonly builds: BuildRequest[] = [];
  readonly operations: Array<{
    kind: 'retag' | 'transfer';
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

  retag(source: string, sourceDigest: string, destination: string): void {
    this.materialize('retag', source, sourceDigest, destination);
  }

  transfer(source: string, sourceDigest: string, destination: string): void {
    this.materialize('transfer', source, sourceDigest, destination);
  }

  private materialize(
    kind: 'retag' | 'transfer',
    source: string,
    sourceDigest: string,
    destination: string,
  ): void {
    const sameRegistry = registry(source) === registry(destination);
    if ((kind === 'retag') !== sameRegistry) {
      throw new Error(`Invalid ${kind} operation ${source} -> ${destination}`);
    }
    this.operations.push({
      kind,
      source,
      digest: sourceDigest,
      destination,
    });
    const sourceImage = this.images.get(source);
    if (!sourceImage) throw new Error(`Missing fake source ${source}`);
    this.images.set(destination, {
      reference: destination,
      digest: sourceDigest,
      labels: sourceImage.labels,
    });
  }
}

function registry(reference: string): string {
  return reference.slice(0, reference.indexOf('/'));
}
