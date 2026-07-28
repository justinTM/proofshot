import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureSourceIdentity } from './source.js';

describe('captureSourceIdentity', () => {
  const root = path.join(process.cwd(), '.proofshot-test-tmp', 'source');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    git('init');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=ProofShot Test', '-c', 'user.email=proofshot@example.test', 'commit', '-m', 'fixture');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('distinguishes clean source and exact dirty content', () => {
    const clean = captureSourceIdentity(root);
    expect(clean).toMatchObject({ kind: 'git', worktree: 'clean', ref: expect.any(String) });
    if (clean.kind !== 'git') throw new Error('expected Git source');
    expect(clean.diffDigest).toBeUndefined();

    fs.writeFileSync(path.join(root, 'untracked.txt'), 'first\n');
    const first = captureSourceIdentity(root);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'second\n');
    const second = captureSourceIdentity(root);
    expect(first).toMatchObject({ kind: 'git', worktree: 'dirty', diffDigest: expect.stringMatching(/^sha256:/) });
    expect(second).toMatchObject({ kind: 'git', worktree: 'dirty', diffDigest: expect.stringMatching(/^sha256:/) });
    if (first.kind !== 'git' || second.kind !== 'git') throw new Error('expected Git source');
    expect(first.diffDigest).not.toBe(second.diffDigest);
  });
});
