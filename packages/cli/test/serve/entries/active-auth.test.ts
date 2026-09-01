import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('active-auth entry coordinator', () => {
  it('does not depend on either public entry module', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../src/serve/entries/active-auth.ts'),
      'utf8',
    );

    expect(source).not.toContain("from './auth.js'");
    expect(source).not.toContain("from './init.js'");
  });
});
