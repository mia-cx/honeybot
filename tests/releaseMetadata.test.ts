import { describe, expect, it } from 'vitest';

import {
  buildBetaVersion,
  imageReferences,
  parseChangesetStatus,
  releaseLabels,
  resolveBaselineReadiness,
  selectEligibleBetaCommits,
} from '../scripts/releaseMetadata.js';

const repositories = {
  ghcr: 'ghcr.io/mia-cx/honeybot',
  dockerhub: 'docker.io/miacx/honeybot',
};
const ref = '0123456789abcdef0123456789abcdef01234567';

describe('release metadata', () => {
  it('uses the Changesets newVersion and rejects unexpected release records', () => {
    expect(
      parseChangesetStatus({
        releases: [
          {
            name: 'honeybot',
            type: 'minor',
            oldVersion: '1.0.1',
            newVersion: '1.1.0',
            changesets: ['feature'],
          },
        ],
      }),
    ).toMatchObject({ newVersion: '1.1.0', type: 'minor' });

    expect(parseChangesetStatus({ releases: [] })).toBeNull();
    expect(() =>
      parseChangesetStatus({
        releases: [
          {
            name: 'other',
            type: 'patch',
            oldVersion: '1.0.0',
            newVersion: '1.0.1',
          },
        ],
      }),
    ).toThrow('Unexpected package');
    expect(() =>
      parseChangesetStatus({
        releases: [
          {
            name: 'honeybot',
            type: 'patch',
            oldVersion: '1.0.0',
            newVersion: '1.0.1',
          },
          {
            name: 'honeybot',
            type: 'minor',
            oldVersion: '1.0.0',
            newVersion: '1.1.0',
          },
        ],
      }),
    ).toThrow('at most one');
  });

  it('builds deterministic beta versions and validates ordinals', () => {
    expect(buildBetaVersion('1.1.0', 1)).toBe('1.1.0-beta.1');
    expect(buildBetaVersion('2.0.0', 42)).toBe('2.0.0-beta.42');
    expect(() => buildBetaVersion('1.1.0-beta.1', 2)).toThrow(
      'must not be a prerelease',
    );
    expect(() => buildBetaVersion('1.1.0', 0)).toThrow('positive integer');
  });

  it('generates full-SHA immutable refs and channel-specific moving aliases', () => {
    const beta = imageReferences(
      { channel: 'beta', version: '1.2.0-beta.3', ref },
      repositories,
    );
    expect(beta.immutable).toEqual([
      'ghcr.io/mia-cx/honeybot:v1.2.0-beta.3',
      'docker.io/miacx/honeybot:v1.2.0-beta.3',
      `ghcr.io/mia-cx/honeybot:sha-${ref}`,
      `docker.io/miacx/honeybot:sha-${ref}`,
    ]);
    expect(beta.moving).toEqual([
      'ghcr.io/mia-cx/honeybot:v1.2-beta',
      'docker.io/miacx/honeybot:v1.2-beta',
      'ghcr.io/mia-cx/honeybot:v1-beta',
      'docker.io/miacx/honeybot:v1-beta',
      'ghcr.io/mia-cx/honeybot:beta',
      'docker.io/miacx/honeybot:beta',
    ]);
    expect(beta.moving).not.toContain('ghcr.io/mia-cx/honeybot:latest');

    const stable = imageReferences(
      { channel: 'stable', version: '1.2.0', ref },
      repositories,
    );
    expect(stable.moving).toContain('ghcr.io/mia-cx/honeybot:latest');
    expect(stable.moving).toContain('docker.io/miacx/honeybot:v1.2');
  });

  it('requires full lowercase commit SHAs and correct channel versions', () => {
    expect(() =>
      imageReferences(
        { channel: 'beta', version: '1.2.0-beta.3', ref: ref.slice(0, 7) },
        repositories,
      ),
    ).toThrow('full 40-character');
    expect(() =>
      imageReferences(
        { channel: 'stable', version: '1.2.0-beta.3', ref },
        repositories,
      ),
    ).toThrow('Stable publication');
    expect(() =>
      imageReferences({ channel: 'beta', version: '1.2.0', ref }, repositories),
    ).toThrow('beta.N');
  });

  it('returns a typed deferred baseline until tag and registry state are complete', () => {
    expect(
      resolveBaselineReadiness({
        version: '1.1.0',
        tagCommit: null,
        publicationComplete: false,
      }),
    ).toEqual({ state: 'deferred', version: '1.1.0', reason: 'missing-tag' });
    expect(
      resolveBaselineReadiness({
        version: '1.1.0',
        tagCommit: ref,
        publicationComplete: false,
      }),
    ).toEqual({
      state: 'deferred',
      version: '1.1.0',
      reason: 'incomplete-publication',
    });
    expect(
      resolveBaselineReadiness({
        version: '1.1.0',
        tagCommit: ref,
        publicationComplete: true,
      }),
    ).toEqual({ state: 'ready', version: '1.1.0', tag: 'v1.1.0', ref });
  });

  it('selects only still-eligible beta snapshots', () => {
    expect(
      selectEligibleBetaCommits([
        { ref, ordinal: 1, nextVersion: null, stableTransition: false },
        { ref, ordinal: 2, nextVersion: '1.1.0', stableTransition: false },
        { ref, ordinal: 3, nextVersion: '1.1.0', stableTransition: true },
      ]),
    ).toEqual([
      { ref, ordinal: 2, nextVersion: '1.1.0', stableTransition: false },
    ]);
  });

  it('emits immutable OCI identity labels', () => {
    expect(
      releaseLabels(
        { channel: 'stable', version: '1.2.0', ref },
        'mia-cx/honeybot',
      ),
    ).toMatchObject({
      'org.opencontainers.image.revision': ref,
      'org.opencontainers.image.version': '1.2.0',
      'org.opencontainers.image.source': 'https://github.com/mia-cx/honeybot',
    });
  });
});
