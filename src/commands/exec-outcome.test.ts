import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(), loadSession: vi.fn(), saveSession: vi.fn(),
}));
vi.mock('../utils/config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../session/state.js', () => ({ loadSession: mocks.loadSession, saveSession: mocks.saveSession }));
vi.mock('../utils/exec.js', () => ({
  ab: vi.fn(), buildAgentBrowserCommand: (command: string) => `agent-browser ${command}`,
  setAgentBrowserDefaults: vi.fn(),
}));

import { execCommand, loadSessionLog } from './exec.js';

describe('exec completed action records', () => {
  const root = path.join(process.cwd(), '.proofshot-test-tmp', 'exec');
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    mocks.loadConfig.mockReturnValue({ output: root, browser: {} });
    mocks.loadSession.mockReturnValue({
      startedAt: '2026-07-27T10:00:00Z', sessionDir: root, sessionName: 'fixture',
      recordingActive: false, videoEnabled: false, viewport: { width: 1280, height: 720 },
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('persists a redacted successful outcome only after execution', async () => {
    const run = vi.fn().mockReturnValue({ status: 0, signal: null, stdout: 'saved private-value', stderr: '' });
    await execCommand(['fill', '@e2', 'private-value'], run);
    const entry = loadSessionLog(root)[0];
    expect(entry.action).toBe('fill @e2 [REDACTED]');
    expect(entry.attemptedAction?.status).toBe('attempted');
    expect(entry.outcome).toMatchObject({ status: 'completed', exitCode: 0, timeout: false, stdout: 'saved [REDACTED]' });
    expect(entry.postcondition?.commandCompleted).toBe(true);
  });

  it('preserves structured argument boundaries and suppresses opaque eval output', async () => {
    const run = vi.fn().mockReturnValue({ status: 0, signal: null, stdout: 'private browser state', stderr: '' });
    await execCommand(['eval', 'document.querySelector("input").value'], run);
    const entry = loadSessionLog(root)[0];
    expect(entry.structuredAction).toEqual({ command: 'eval', args: ['[REDACTED]'], redacted: true });
    expect(entry.outcome?.stdout).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('private browser state');
    expect(JSON.stringify(entry)).not.toContain('querySelector');
  });

  it('persists failure before propagating the CLI exit', async () => {
    const run = vi.fn().mockReturnValue({ status: 7, signal: null, stdout: '', stderr: 'detached' });
    await expect(execCommand(['click', '@e4'], run)).rejects.toThrow('exit:7');
    const entry = loadSessionLog(root)[0];
    expect(entry.outcome).toMatchObject({ status: 'failed', exitCode: 7, stderr: 'detached' });
    expect(entry.postcondition?.commandCompleted).toBe(false);
  });
});
