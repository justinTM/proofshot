import { describe, expect, it } from 'vitest';
import {
  redactArgv,
  redactArgvWithManifest,
  redactEnvironment,
  redactText,
  REDACTED,
  scanResidualSecrets,
} from './redact.js';

describe('terminal redaction', () => {
  it('classifies flag/value and assignment pairs before retaining structured argv', () => {
    expect(redactArgv(['odo', '--token', 'top-secret', '--password=hunter2', '--name', 'safe'])).toEqual([
      'odo', '--token', REDACTED, `--password=${REDACTED}`, '--name', 'safe',
    ]);
  });

  it('propagates classified argv values into stream redaction without persisting them', () => {
    const result = redactArgvWithManifest(['odo', '--token', 'top-secret']);
    expect(result.argv).toEqual(['odo', '--token', REDACTED]);
    expect(redactText('echo top-secret', { secretValues: result.secretValues })).toBe(`echo ${REDACTED}`);
    expect(JSON.stringify(result.manifest)).not.toContain('top-secret');
  });

  it('redacts environment values before persistence and produces a digest', () => {
    const result = redactEnvironment({ LANG: 'C.UTF-8', GITLAB_TOKEN: 'top-secret' }, ['GITLAB_TOKEN', 'LANG']);
    expect(result.allowlisted).toEqual({ GITLAB_TOKEN: REDACTED, LANG: 'C.UTF-8' });
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.manifest).toEqual([{
      location: 'environment', classification: 'sensitive-environment', count: 1,
    }]);
  });

  it('fails residual scans closed for recognized secret forms', () => {
    expect(scanResidualSecrets('Authorization: Bearer abcdefghijklmnop').passed).toBe(false);
    expect(scanResidualSecrets('glpat-abcdefghijklmnop').passed).toBe(false);
    expect(scanResidualSecrets('ordinary output').passed).toBe(true);
  });
});
