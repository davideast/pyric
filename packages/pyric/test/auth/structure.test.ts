import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUTH_SRC = resolve(import.meta.dirname, '../../src/auth');

describe('Auth surface structure', () => {
  it('keeps the modular composition file below the documented split trigger', () => {
    const lines = readFileSync(resolve(AUTH_SRC, 'modular.ts'), 'utf8').split('\n').length;
    expect(lines).toBeLessThanOrEqual(600);
  });

  it('places the new persistence backend concept under auth/sandbox', () => {
    expect(existsSync(resolve(AUTH_SRC, 'persistence.ts'))).toBe(false);
    expect(existsSync(resolve(AUTH_SRC, 'sandbox/persistence.ts'))).toBe(true);
  });
});
