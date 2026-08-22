import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DockerBuildxAdapter,
  publicationComplete,
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
import { runGit } from '../scripts/releaseGit.js';

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

describe('runtime image', () => {
  it('installs fontconfig and a sans-serif font for rendered settings graphs', () => {
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
    const runtimeStage = dockerfile.slice(
      dockerfile.indexOf('FROM base AS runtime'),
    );

    expect(runtimeStage).toContain('fontconfig');
    expect(runtimeStage).toContain('fonts-dejavu-core');
    expect(runtimeStage).toContain('XDG_CACHE_HOME=/app/.cache');
    expect(runtimeStage).toContain('.cache/fontconfig');
  });
});

describe('registry publication adapter', () => {
  it('uses a real registry transfer for cross-registry copies', () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const adapter = new DockerBuildxAdapter({
      capture: () => '',
      stream: (command, args) => {
        commands.push({ command, args });
      },
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
    const adapter = new DockerBuildxAdapter({
      capture: () => '',
      stream: (command, args) => {
        commands.push({ command, args });
      },
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
    const adapter = new DockerBuildxAdapter({
      capture: () =>
        JSON.stringify({
          manifest: { digest },
          image: {
            'linux/amd64': { config: {} },
          },
        }),
      stream: () => {
        throw new Error('inspect must not use the streaming command path');
      },
    });

    expect(
      adapter.inspect('docker.io/miacx/honeybot:v1.0.1'),
    ).toEqual({
      reference: 'docker.io/miacx/honeybot:v1.0.1',
      digest,
      labels: {},
    });
  });

  it('ignores provenance attestations when comparing platform labels', () => {
    const labels = releaseLabels(identity, repository);
    const adapter = new DockerBuildxAdapter({
      capture: () =>
        JSON.stringify({
          manifest: { digest },
          image: {
            'linux/amd64': { config: { Labels: labels } },
            'linux/arm64': { config: { Labels: labels } },
            'unknown/unknown': { config: {} },
          },
        }),
      stream: () => {
        throw new Error('inspect must not use the streaming command path');
      },
    });

    expect(adapter.inspect('ghcr.io/mia-cx/honeybot:v1.2.0-beta.3')).toEqual({
      reference: 'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      labels,
    });
  });

  it.each([{}, { config: 'invalid' }])(
    'rejects a malformed platform image config %#',
    (platformImage) => {
      const adapter = new DockerBuildxAdapter({
        capture: () =>
          JSON.stringify({
            manifest: { digest },
            image: { 'linux/amd64': platformImage },
          }),
        stream: () => {
          throw new Error('inspect must not use the streaming command path');
        },
      });

      expect(() =>
        adapter.inspect('docker.io/miacx/honeybot:v1.0.1'),
      ).toThrow('Image config missing');
    },
  );

  it('streams image build output instead of capturing it in memory', () => {
    const streamed: Array<{ command: string; args: string[] }> = [];
    const adapter = new DockerBuildxAdapter({
      capture: () => {
        throw new Error('build must not use the captured command path');
      },
      stream: (command, args) => {
        streamed.push({ command, args });
        const metadataIndex = args.indexOf('--metadata-file');
        const metadataFile = args[metadataIndex + 1];
        if (!metadataFile) throw new Error('metadata file argument missing');
        writeFileSync(
          metadataFile,
          JSON.stringify({ 'containerimage.digest': digest }),
        );
      },
    });
    const currentRef = runGit(['rev-parse', 'HEAD']);

    expect(
      adapter.build({
        identity: { channel: 'stable', version: '1.0.1', ref: currentRef },
        references: ['ghcr.io/mia-cx/honeybot:v1.0.1'],
        labels: releaseLabels(
          { channel: 'stable', version: '1.0.1', ref: currentRef },
          repository,
        ),
      }),
    ).toBe(digest);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.args.slice(0, 2)).toEqual(['buildx', 'build']);
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

  it('does not let a missing reference hide a present identity conflict', () => {
    const adapter = new FakeAdapter();
    adapter.images.set('ghcr.io/mia-cx/honeybot:v1.2.0-beta.3', {
      reference: 'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      digest,
      labels: {
        ...releaseLabels(identity, repository),
        'org.opencontainers.image.revision': 'wrong',
      },
    });

    expect(() =>
      publicationComplete({ identity, repositories, repository }, adapter),
    ).toThrow('Conflicting org.opencontainers.image.revision');
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
