import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireFullCommitSha } from './releaseMetadata.js';

export const AUTOMATION_GIT_NAME = 'github-actions[bot]';
export const AUTOMATION_GIT_EMAIL =
  '41898282+github-actions[bot]@users.noreply.github.com';

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  } = {},
): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return '';
    const detail = commandError(error);
    throw new Error(
      `${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    );
  }
}

export function runGit(args: string[], cwd = process.cwd()): string {
  return runCommand('git', args, { cwd });
}

export function fetchMainAndTags(
  remote = 'origin',
  branch = 'main',
  cwd = process.cwd(),
): string {
  runGit(
    [
      'fetch',
      '--force',
      '--tags',
      remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    ],
    cwd,
  );
  return requireFullCommitSha(
    runGit(['rev-parse', `${remote}/${branch}^{commit}`], cwd),
  );
}

export function resolveTagCommit(
  tag: string,
  cwd = process.cwd(),
): string | null {
  validateTagName(tag, cwd);
  const exists = runCommand(
    'git',
    ['show-ref', '--verify', '--hash', `refs/tags/${tag}`],
    {
      cwd,
      allowFailure: true,
    },
  );
  if (exists === '') return null;
  return requireFullCommitSha(
    runGit(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], cwd),
  );
}

export function resolveStableTagCommit(
  version: string,
  cwd = process.cwd(),
): string | null {
  const tag = `v${version}`;
  const ref = resolveTagCommit(tag, cwd);
  if (ref !== null && packageVersionAt(ref, cwd) !== version) {
    throw new Error(
      `Stable tag ${tag} does not point to package version ${version}`,
    );
  }
  return ref;
}

export function fetchTag(
  tag: string,
  remote = 'origin',
  cwd = process.cwd(),
): void {
  validateTagName(tag, cwd);
  try {
    runGit(
      ['fetch', '--force', remote, `refs/tags/${tag}:refs/tags/${tag}`],
      cwd,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /couldn't find remote ref|remote ref does not exist/i.test(error.message)
    ) {
      return;
    }
    throw error;
  }
}

export function configureAutomationIdentity(cwd = process.cwd()): void {
  runGit(['config', '--local', 'user.name', AUTOMATION_GIT_NAME], cwd);
  runGit(['config', '--local', 'user.email', AUTOMATION_GIT_EMAIL], cwd);
  const name = runGit(['config', '--local', '--get', 'user.name'], cwd);
  const email = runGit(['config', '--local', '--get', 'user.email'], cwd);
  if (name !== AUTOMATION_GIT_NAME || email !== AUTOMATION_GIT_EMAIL) {
    throw new Error(
      'Failed to configure deterministic repository-local Git identity',
    );
  }
}

export function createAnnotatedTag(
  tag: string,
  ref: string,
  cwd = process.cwd(),
): void {
  validateTagName(tag, cwd);
  requireFullCommitSha(ref);
  configureAutomationIdentity(cwd);
  runGit(['tag', '--annotate', tag, ref, '--message', tag], cwd);
  const target = resolveTagCommit(tag, cwd);
  if (target !== ref) {
    throw new Error(
      `Created tag ${tag} peels to ${target ?? 'nothing'}, expected ${ref}`,
    );
  }
}

export function pushTag(
  tag: string,
  remote = 'origin',
  cwd = process.cwd(),
): void {
  validateTagName(tag, cwd);
  runGit(['push', remote, `refs/tags/${tag}:refs/tags/${tag}`], cwd);
}

export function packageVersionAt(ref: string, cwd = process.cwd()): string {
  requireFullCommitSha(ref);
  const value: unknown = JSON.parse(
    runGit(['show', `${ref}:package.json`], cwd),
  );
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new Error(`package.json at ${ref} has no string version`);
  }
  return value.version;
}

export function firstParentCommits(
  range: string,
  cwd = process.cwd(),
): string[] {
  const output = runGit(
    ['rev-list', '--reverse', '--first-parent', range],
    cwd,
  );
  return output === '' ? [] : output.split('\n').map(requireFullCommitSha);
}

export function firstParentDistance(
  baseRef: string,
  candidateRef: string,
  cwd = process.cwd(),
): number {
  const value = runGit(
    ['rev-list', '--count', '--first-parent', `${baseRef}..${candidateRef}`],
    cwd,
  );
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid first-parent distance: ${value}`);
  }
  return count;
}

export function listTags(pattern: string, cwd = process.cwd()): string[] {
  const output = runGit(['tag', '--list', pattern], cwd);
  return output === '' ? [] : output.split('\n').filter(Boolean);
}

export function isAncestor(
  ancestor: string,
  descendant: string,
  cwd = process.cwd(),
): boolean {
  requireFullCommitSha(ancestor);
  requireFullCommitSha(descendant);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function withDetachedWorktree<T>(
  ref: string,
  operation: (worktree: string) => T,
  cwd = process.cwd(),
): T {
  requireFullCommitSha(ref);
  const directory = mkdtempSync(join(tmpdir(), 'honeybot-release-'));
  try {
    runGit(['worktree', 'add', '--detach', directory, ref], cwd);
    return operation(directory);
  } finally {
    runCommand('git', ['worktree', 'remove', '--force', directory], {
      cwd,
      allowFailure: true,
    });
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readPackageVersion(cwd: string): string {
  const value: unknown = JSON.parse(
    readFileSync(join(cwd, 'package.json'), 'utf8'),
  );
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new Error(`package.json in ${cwd} has no string version`);
  }
  return value.version;
}

function validateTagName(tag: string, cwd: string): void {
  if (!tag || tag.includes('..') || tag.startsWith('-'))
    throw new Error(`Invalid tag name: ${tag}`);
  runCommand('git', ['check-ref-format', `refs/tags/${tag}`], { cwd });
}

function commandError(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const stderr = error.stderr;
  const stdout = error.stdout;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  if (Buffer.isBuffer(stderr) && stderr.length > 0)
    return stderr.toString('utf8').trim();
  if (typeof stdout === 'string' && stdout.trim()) return stdout.trim();
  if (Buffer.isBuffer(stdout) && stdout.length > 0)
    return stdout.toString('utf8').trim();
  if (typeof error.message === 'string') return error.message;
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
