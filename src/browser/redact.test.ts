import { describe, expect, it } from 'vitest';
import { redactBrowserAction, redactBrowserUrl } from './redact.js';

describe('browser redaction', () => {
  it('preserves argument boundaries while suppressing form values', () => {
    expect(redactBrowserAction(['fill', '@e1', 'value with spaces'])).toMatchObject({
      action: 'fill @e1 [REDACTED]',
      args: ['fill', '@e1', '[REDACTED]'],
      secretValues: ['value with spaces'],
    });
  });

  it('suppresses opaque eval source and output', () => {
    expect(redactBrowserAction(['eval', 'document.cookie'])).toMatchObject({
      action: 'eval [REDACTED]', redactOutput: true,
    });
  });

  it('redacts URL credentials and sensitive query values', () => {
    const result = redactBrowserUrl('https://person:password@example.test/app?token=secret&view=full');
    expect(result.redacted).toBe(true);
    expect(result.url).toContain('view=full');
    expect(result.url).not.toContain('person');
    expect(result.url).not.toContain('password');
    expect(result.url).not.toContain('secret');
  });
});
