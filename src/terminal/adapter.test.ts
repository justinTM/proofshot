import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureTerminal } from './adapter.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('first-party terminal adapter', () => {
  it('captures direct argv without shell interpolation and preserves exact JSON stdout', async () => {
    const cwd = await mkdtemp(join(process.cwd(), '.proofshot-terminal-test-'));
    directories.push(cwd);
    const result = await captureTerminal({
      argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ok:true}))'],
      cwd, expectedJson: true, environment: { LANG: 'C.UTF-8', TERM: 'xterm-256color' },
      environmentAllowlist: ['LANG', 'TERM'],
      terminal: { columns: 88, glyphs: 'unicode', color: true },
      executor: async () => ({ stdout: '{"ok":true}', stderr: '', exitCode: 0 }),
    });
    expect(result.command.argv[0]).toBe(process.execPath);
    expect(result.outcome).toMatchObject({ kind: 'exit', exitCode: 0, stdout: '{"ok":true}' });
    expect(result.outcome.json).toMatchObject({ exactStdout: '{"ok":true}', parsed: true });
    expect(result.terminal).toMatchObject({
      mode: 'pipe', modeEvidence: 'captured', columns: 88,
      glyphs: 'unicode', color: true, term: 'xterm-256color', locale: 'C.UTF-8',
    });
  });

  it('distinguishes nonzero exit, spawn errors, and timeout', async () => {
    const cwd = await mkdtemp(join(process.cwd(), '.proofshot-terminal-test-'));
    directories.push(cwd);
    const exited = await captureTerminal({
      argv: [process.execPath, '-e', 'process.stderr.write("no");process.exit(7)'], cwd,
      executor: async () => ({ stdout: '', stderr: 'no', exitCode: 7 }),
    });
    expect(exited.outcome).toMatchObject({ kind: 'exit', exitCode: 7, stdout: '', stderr: 'no' });
    expect(exited.status).toBe('fail');
    const missing = await captureTerminal({ argv: ['definitely-not-a-proofshot-tool'], cwd });
    expect(missing.outcome.kind).toBe('spawn_error');
    const timeout = await captureTerminal({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 1000)'], cwd, timeoutMilliseconds: 10 });
    expect(timeout.outcome.kind).toBe('timeout');
  });

  it('redacts argv, environment, streams, and secret keystrokes before returning a record', async () => {
    const cwd = await mkdtemp(join(process.cwd(), '.proofshot-terminal-test-'));
    directories.push(cwd);
    const result = await captureTerminal({
      argv: ['odo', '--token', 'top-secret'],
      cwd,
      environment: { GITLAB_TOKEN: 'top-secret', LANG: 'C.UTF-8' },
      environmentAllowlist: ['GITLAB_TOKEN', 'LANG'],
      keystrokes: [{ text: 'top-secret', secret: true }, { key: 'Enter' }],
      executor: async () => ({ stdout: 'token=top-secret', stderr: '', exitCode: 0 }),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('top-secret');
    expect(result.command.argv).toEqual(['odo', '--token', '[REDACTED]']);
    expect(result.environment.allowlisted).toEqual({ GITLAB_TOKEN: '[REDACTED]', LANG: 'C.UTF-8' });
    expect(result.outcome.stdout).toBe('token=[REDACTED]');
    expect(result.keystrokes[0]).toEqual({ sequence: 0, secretEntry: true });
    expect(result.redactionManifest.map(({ location }) => location)).toEqual(
      expect.arrayContaining(['argv', 'environment', 'stdout', 'keystroke']),
    );
  });

  it('digests generated files and rejects uncaptured URL bytes or secret-bearing artifacts', async () => {
    const cwd = await mkdtemp(join(process.cwd(), '.proofshot-terminal-test-'));
    directories.push(cwd);
    await writeFile(join(cwd, 'report.json'), '{"ok":true}\n');
    const result = await captureTerminal({
      argv: ['odo', 'report'],
      cwd,
      generatedArtifacts: [{
        kind: 'file', locator: 'report.json', mediaType: 'application/json',
      }],
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    expect(result.generatedArtifacts[0]).toMatchObject({
      kind: 'file', locator: 'report.json', mediaType: 'application/json', sizeBytes: 12,
    });
    expect(result.generatedArtifacts[0].digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    await expect(captureTerminal({
      argv: ['odo', 'url'], cwd,
      generatedArtifacts: [{ kind: 'url', locator: 'https://example.test/result', mediaType: 'text/html' }],
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    })).rejects.toThrow('requires captured content');

    await writeFile(join(cwd, 'secret.txt'), 'Authorization: Bearer abcdefghijklmnop');
    await expect(captureTerminal({
      argv: ['odo', 'secret'], cwd,
      generatedArtifacts: [{ kind: 'file', locator: 'secret.txt', mediaType: 'text/plain' }],
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    })).rejects.toThrow('contains secret material');
  });
});
