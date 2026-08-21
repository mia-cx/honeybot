import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_GIT_EMAIL,
  AUTOMATION_GIT_NAME,
  configureAutomationIdentity,
  createAnnotatedTag,
  describeError,
  fetchTag,
  pushTag,
  resolveStableTagCommit,
  resolveTagCommit,
  runGit,
} from '../scripts/releaseGit.js';

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('release Git adapter', () => {
  it('configures deterministic local identity and peels annotated tags to commits', () => {
    const repository = createRepository();
    runGit(['config', '--local', '--unset-all', 'user.name'], repository);
    runGit(['config', '--local', '--unset-all', 'user.email'], repository);

    configureAutomationIdentity(repository);
    expect(
      runGit(['config', '--local', '--get', 'user.name'], repository),
    ).toBe(AUTOMATION_GIT_NAME);
    expect(
      runGit(['config', '--local', '--get', 'user.email'], repository),
    ).toBe(AUTOMATION_GIT_EMAIL);

    const commit = runGit(['rev-parse', 'HEAD'], repository);
    createAnnotatedTag('v1.0.0', commit, repository);
    const rawTagObject = runGit(['rev-parse', 'refs/tags/v1.0.0'], repository);

    expect(rawTagObject).not.toBe(commit);
    expect(resolveTagCommit('v1.0.0', repository)).toBe(commit);
  });

  it('accepts lightweight tags through the same peeled target contract', () => {
    const repository = createRepository();
    const commit = runGit(['rev-parse', 'HEAD'], repository);
    runGit(['tag', 'v1.0.0', commit], repository);
    expect(resolveTagCommit('v1.0.0', repository)).toBe(commit);
    expect(resolveStableTagCommit('1.0.0', repository)).toBe(commit);
    expect(resolveTagCommit('v2.0.0', repository)).toBeNull();
  });

  it('rejects stable tags whose commit contains a different package version', () => {
    const repository = createRepository();
    const commit = runGit(['rev-parse', 'HEAD'], repository);
    runGit(['tag', 'v2.0.0', commit], repository);
    expect(() => resolveStableTagCommit('2.0.0', repository)).toThrow(
      'does not point to package version 2.0.0',
    );
  });

  it('distinguishes a local-only tag from a confirmed remote tag', () => {
    const repository = createRepository();
    const remote = mkdtempSync(join(tmpdir(), 'honeybot-release-remote-'));
    repositories.push(remote);
    runGit(['init', '--bare'], remote);
    runGit(['remote', 'add', 'origin', remote], repository);
    runGit(['push', '--set-upstream', 'origin', 'main'], repository);

    const commit = runGit(['rev-parse', 'HEAD'], repository);
    createAnnotatedTag('v1.0.0', commit, repository);

    expect(fetchTag('v1.0.0', 'origin', repository)).toBe(false);
    pushTag('v1.0.0', 'origin', repository);
    expect(fetchTag('v1.0.0', 'origin', repository)).toBe(true);
  });

  it('formats caught release errors without discarding their message', () => {
    expect(describeError(new Error('conflicting immutable tag'))).toBe(
      'conflicting immutable tag',
    );
    expect(describeError('plain failure')).toBe('plain failure');
  });

  it('redacts raw, encoded, and URL-embedded credentials from diagnostics', () => {
    const token = 'release-token-value';
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    const diagnostic = describeError(
      new Error(
        `push failed: ${token} AUTHORIZATION: basic ${encoded} https://user:password@example.com`,
      ),
      { RELEASE_GITHUB_TOKEN: token },
    );

    expect(diagnostic).toContain('push failed');
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain(encoded);
    expect(diagnostic).not.toContain('user:password');
    expect(diagnostic.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'honeybot-release-git-'));
  repositories.push(repository);
  runGit(['init', '--initial-branch=main'], repository);
  runGit(['config', 'user.name', 'Test Author'], repository);
  runGit(['config', 'user.email', 'test@example.com'], repository);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'honeybot', version: '1.0.0', private: true }, null, 2)}\n`,
  );
  runGit(['add', 'README.md', 'package.json'], repository);
  runGit(['commit', '--message', 'initial'], repository);
  return repository;
}
