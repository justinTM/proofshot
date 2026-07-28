import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateProofBundle } from '../evidence/validate.js';
import { importOdoCliMatrix, type DeclaredTerminalContext } from './import-odo.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const run = (overrides: Record<string, unknown> = {}) => ({
  scenario_id: 'help-88',
  runner: 'host',
  command: ['odo', '--help'],
  status: 'pass',
  exit_code: 0,
  stdout: '✓ ok',
  stderr: '',
  duration_seconds: 0.125,
  detail: '',
  ...overrides,
});

function context(
  mode: 'pipe' | 'pty',
  columns: number,
  color: boolean,
  glyphs: 'unicode' | 'ascii',
): DeclaredTerminalContext {
  return { mode, rows: 24, columns, color, glyphs, term: 'xterm-256color', locale: 'C.UTF-8' };
}

describe('ODO cli_matrix importer', () => {
  it('preserves native outcomes, explicit terminal modes, separate streams, redaction, and generated artifacts', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.proofshot-import-test-'));
    directories.push(dir);
    const input = join(dir, 'runs.jsonl');
    const records = [
      run({
        scenario_id: 'success-52',
        command: ['odo', '--token', 'top-secret', '--width', '52'],
        stdout: 'token=top-secret',
      }),
      run({
        scenario_id: 'expected-exit-88',
        status: 'pass',
        exit_code: 2,
        stderr: 'expected usage failure',
      }),
      run({ scenario_id: 'failed-120', status: 'fail', exit_code: 7, stderr: 'unexpected failure' }),
      run({
        scenario_id: 'blocked-timeout',
        status: 'blocked-external',
        exit_code: null,
        detail: 'timed out after 5s',
      }),
      run({
        scenario_id: 'malformed-json',
        status: 'fail',
        exit_code: 0,
        stdout: '{bad',
        command: ['odo', '--json'],
      }),
      run({ scenario_id: 'pty-ascii', runner: 'host-pty', stdout: 'ok\r\n', command: ['odo'] }),
    ];
    await writeFile(input, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
    const output = join(dir, 'bundle');
    const result = await importOdoCliMatrix({
      input,
      outputDirectory: output,
      cwd: dir,
      environment: { NO_COLOR: '1', GITLAB_TOKEN: 'top-secret', LANG: 'C.UTF-8' },
      terminalContexts: {
        'success-52': context('pipe', 52, true, 'unicode'),
        'expected-exit-88': context('pipe', 88, true, 'unicode'),
        'failed-120': context('pipe', 120, true, 'unicode'),
        'blocked-timeout': context('pipe', 88, false, 'unicode'),
        'malformed-json': context('pipe', 88, false, 'unicode'),
        'pty-ascii': context('pty', 52, false, 'ascii'),
      },
      generatedArtifacts: {
        'success-52': [
          { kind: 'file', locator: 'report.txt', mediaType: 'text/plain', content: 'report body\n' },
          { kind: 'url', locator: 'https://example.test/result', mediaType: 'text/html', content: '<h1>Result</h1>' },
        ],
      },
      keystrokes: { 'pty-ascii': [{ text: 'top-secret', secret: true }, { key: 'Enter' }] },
      now: new Date('2026-07-28T00:00:00Z'),
    });

    expect(result.observations).toHaveLength(6);
    expect(result.observations.map(({ terminal }) => terminal.columns)).toEqual([52, 88, 120, 88, 88, 52]);
    expect(result.observations[0].terminal).toMatchObject({ color: true, glyphs: 'unicode' });
    expect(result.observations[1]).toMatchObject({ status: 'pass', outcome: { kind: 'exit', exitCode: 2 } });
    expect(result.observations[3].outcome).toMatchObject({ kind: 'timeout', timeSource: 'import_inferred' });
    expect(result.observations[4].outcome.json).toMatchObject({ exactStdout: '{bad', parsed: false });
    expect(result.observations[5].outcome).toMatchObject({
      kind: 'exit',
      streams: 'pty_merged',
      events: [{ sequence: 0, stream: 'pty', text: 'ok\r\n' }],
    });
    expect(result.observations[5].terminal).toMatchObject({
      mode: 'pty', modeEvidence: 'declared', columns: 52, color: false, glyphs: 'ascii',
    });
    expect(result.observations[5].keystrokes[0]).toEqual({ sequence: 0, secretEntry: true });
    expect(result.observations[0].generatedArtifacts).toHaveLength(2);

    const contents = new Map(await Promise.all(result.proof.evidence.map(async (item) => [
      item.uri,
      await readFile(join(output, item.uri)),
    ] as const)));
    expect(validateProofBundle(result.proof, {
      now: new Date('2026-07-28T00:00:00Z'),
      resolveEvidence: (item) => contents.get(item.uri),
    }).valid).toBe(true);
    expect(result.proof.evidence.map(({ id }) => id)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^stdout-/),
      expect.stringMatching(/^stderr-/),
      expect.stringMatching(/^pty-/),
      expect.stringMatching(/^artifact-/),
    ]));
    expect(result.proof.actualObservations[0].evidenceIds.length).toBeGreaterThanOrEqual(5);

    const evidenceText = (await Promise.all((await readdir(join(output, 'evidence')))
      .map((name) => readFile(join(output, 'evidence', name), 'utf8')))).join('\n');
    expect(`${JSON.stringify(result)}\n${evidenceText}`).not.toContain('top-secret');
    expect(result.observations[0].environment.allowlisted).toMatchObject({ GITLAB_TOKEN: '[REDACTED]' });
    expect(result.observations[0].outcome.stdout).toBe('token=[REDACTED]');
    expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))).toMatchObject({
      mediaType: 'application/vnd.proofshot.terminal-bundle+json',
      locator: 'bundle.json',
      evidence: expect.any(Array),
    });
  });

  it('requires explicit terminal context and refuses to invent PTY stream order', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.proofshot-import-test-'));
    directories.push(dir);
    const input = join(dir, 'runs.jsonl');
    await writeFile(input, `${JSON.stringify(run({ runner: 'host-pty', stdout: 'out', stderr: 'err' }))}\n`);

    await expect(importOdoCliMatrix({
      input, outputDirectory: join(dir, 'missing-context'), cwd: dir,
    })).rejects.toThrow('Terminal context must be declared');

    await expect(importOdoCliMatrix({
      input, outputDirectory: join(dir, 'unknown-order'), cwd: dir, terminalMode: 'pty',
    })).rejects.toThrow('refusing to invent stream order');
  });

  it('rejects malformed input JSONL without persisting a partial bundle', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.proofshot-import-test-'));
    directories.push(dir);
    const output = join(dir, 'out');
    await writeFile(join(dir, 'runs.jsonl'), '{bad\n');
    await expect(importOdoCliMatrix({
      input: join(dir, 'runs.jsonl'), outputDirectory: output, cwd: dir, terminalMode: 'pipe',
    })).rejects.toThrow('Malformed runs.jsonl at line 1');
    await expect(access(output)).rejects.toThrow();
  });
});
