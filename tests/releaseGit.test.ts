import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTOMATION_GIT_EMAIL,
  AUTOMATION_GIT_NAME,
  configureAutomationIdentity,
  createAnnotatedTag,
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
