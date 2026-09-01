import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('init entry dependency boundary', () => {
  it('uses the active-auth coordinator instead of importing firebase/auth', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../src/serve/entries/init.ts'),
      'utf8',
    );

    expect(source).toContain("from './active-auth.js'");
    expect(source).not.toContain("from './auth.js'");
  });
});
