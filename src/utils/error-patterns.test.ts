import { describe, expect, it } from 'vitest';
import { extractServerErrors } from './error-patterns.js';

describe('extractServerErrors', () => {
  it('ignores favicon 404 noise', () => {
    const errors = extractServerErrors('[server] Error: GET /favicon.ico returned 404');

    expect(errors).toEqual([]);
  });
});
