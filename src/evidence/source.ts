import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GitSourceIdentity, SourceIdentity } from './contract.js';

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function digest(parts: Array<string | Buffer>): `sha256:${string}` {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest('hex')}`;
}

function dirtyDigest(cwd: string, status: Buffer): `sha256:${string}` {
  const diff = git(cwd, ['diff', '--binary', 'HEAD', '--']);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const parts: Array<string | Buffer> = [status, diff];
  for (const relativePath of untracked) {
    const filePath = resolve(cwd, relativePath);
    const stat = lstatSync(filePath);
    parts.push(`\0${relativePath}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) parts.push(readlinkSync(filePath));
    else if (stat.isFile()) parts.push(readFileSync(filePath));
  }
  return digest(parts);
}

/** Capture source identity without persisting source contents or diff text. */
export function captureSourceIdentity(cwd = process.cwd()): SourceIdentity {
  try {
    const head = git(cwd, ['rev-parse', 'HEAD']).toString('utf8').trim();
    const ref = (() => {
      try {
        return git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).toString('utf8').trim() || null;
      } catch {
        return null;
      }
    })();
    const repository = (() => {
      try {
        return git(cwd, ['config', '--get', 'remote.origin.url']).toString('utf8').trim()
          || pathToFileURL(cwd).href;
      } catch {
        return pathToFileURL(cwd).href;
      }
    })();
    const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const treeObject = git(cwd, ['rev-parse', 'HEAD^{tree}']).toString('utf8').trim();
    const source: GitSourceIdentity = {
      kind: 'git',
      repository,
      head,
      ref,
      worktree: status.length === 0 ? 'clean' : 'dirty',
      treeDigest: digest([treeObject]),
    };
    if (source.worktree === 'dirty') source.diffDigest = dirtyDigest(cwd, status);
    return source;
  } catch {
    return { kind: 'non_git', locator: pathToFileURL(cwd).href };
  }
}
