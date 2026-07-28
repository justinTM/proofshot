import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BrowserImportContext } from './evidence.js';
import { importAgentBrowserSession } from './import-agent-browser.js';
import { importPlaywrightTraceFixture } from './import-playwright-trace.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/browser/${name}`, import.meta.url)), 'utf8');
const context = (targetClass: 'local' | 'deployed_readonly' = 'deployed_readonly'): BrowserImportContext => ({
  target: {
    class: targetClass,
    url: targetClass === 'local' ? 'http://localhost:3000/form' : 'https://deployed.test/form',
    origin: targetClass === 'local' ? 'http://localhost:3000' : 'https://deployed.test',
    deploymentId: targetClass === 'deployed_readonly' ? 'deploy-42' : undefined,
    buildId: 'build-42', sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  source: { kind: 'git', repository: 'https://example.test/repo.git', head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ref: 'main', worktree: 'clean' },
  runtime: {
    browser: { name: 'chromium', version: '128.0' }, driver: { name: 'fixture', version: '1.0' },
    configurationVersion: 'fixture-v1', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2,
    renderSettings: { colorScheme: 'light', reducedMotion: true },
  },
});

describe('browser evidence importers', () => {
  it('normalizes current agent-browser outcomes without deriving assertions from captions', () => {
    const result = importAgentBrowserSession(fixture('agent-browser-session.json'), context());
    expect(result.observations.map(({ interaction }) => interaction?.status)).toEqual(['completed', 'failed']);
    expect(result.observations[0].events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'console', level: 'error' }),
      expect.objectContaining({ kind: 'network', status: 500 }),
    ]));
    expect(result.observations[1].captureHealth.console).toBe('blocked');
    expect(result.observations[1].captureHealth.network).toBe('not_observed');
    expect(JSON.stringify(result)).not.toContain('person@example.test');
    expect(JSON.stringify(result)).not.toContain('private clipboard');
    expect(result.observations[0].artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'accessibility', value: { role: 'form' } }),
      expect.objectContaining({ kind: 'keyboard', value: 'Tab' }),
      expect.objectContaining({ kind: 'focus', value: 'submit' }),
    ]));
    expect(result.observations[0].captureHealth).toMatchObject({
      focus: 'observed', keyboard: 'observed', clipboard: 'blocked',
    });
    expect(result.observations[0].provenanceDrift.detected).toBe(true);
    expect(result.observations[0].proofBoundary).toBe('live_readonly');
  });

  it('imports dependency-free Playwright trace-style JSONL through the same contract', () => {
    const result = importPlaywrightTraceFixture(fixture('playwright-trace.jsonl'), context('local'));
    const observation = result.observations[0];
    expect(observation.target.class).toBe('local');
    expect(observation.proofBoundary).toBe('local_runtime');
    expect(observation.captureHealth).toMatchObject({ screenshot: 'observed', accessibility: 'observed', console: 'blocked', network: 'observed', video: 'not_observed' });
    expect(observation.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'console', level: 'error' }),
      expect.objectContaining({ kind: 'network', status: 503 }),
    ]));
    expect(JSON.stringify(result)).not.toContain('private form value');
    expect(JSON.stringify(result)).not.toContain('private clipboard');
  });

  it('never upgrades a missing outcome or collection failure to clean', () => {
    const result = importAgentBrowserSession([{ action: 'click @e1', capture: { networkAttempted: true, networkFailed: true } }], context());
    expect(result.observations[0].interaction?.status).toBe('not_observed');
    expect(result.observations[0].captureHealth.network).toBe('blocked');
    expect(result.warnings).toHaveLength(1);
  });

  it('fails closed on incomplete success, event overrides, and echoed form secrets', () => {
    const result = importAgentBrowserSession([{
      structuredAction: { command: 'fill', args: ['@e1', 'value with spaces'] },
      outcome: {
        status: 'completed', exitCode: 9, completedAt: '2026-07-27T12:00:01Z',
        stdout: 'echo value with spaces',
      },
      console: [{ kind: 'network', health: 'blocked', message: 'value with spaces' }],
      artifacts: [{ kind: 'screenshot', health: 'blocked', reason: 'capture crashed' }],
    }], context());
    const observation = result.observations[0];
    expect(observation.interaction).toMatchObject({
      action: 'fill @e1 [REDACTED]', status: 'not_observed', stdout: 'echo [REDACTED]',
    });
    expect(observation.events[0]).toMatchObject({ kind: 'console', health: 'observed', message: '[REDACTED]' });
    expect(observation.captureHealth.screenshot).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('value with spaces');
  });

  it('rejects deployed imports without immutable target identity', () => {
    const invalid = context();
    delete invalid.target.deploymentId;
    expect(() => importAgentBrowserSession([], invalid)).toThrow('deploymentId and buildId');
  });
});
