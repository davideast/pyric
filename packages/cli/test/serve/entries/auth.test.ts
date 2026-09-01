import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('firebase/auth entry dependency boundary', () => {
  it('registers handles through the active-auth coordinator', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../src/serve/entries/auth.ts'),
      'utf8',
    );

    expect(source).toContain("from './active-auth.js'");
  });
});
