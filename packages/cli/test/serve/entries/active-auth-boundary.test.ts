import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const entriesDir = join(import.meta.dir, '../../../src/serve/entries');

describe('active auth entry boundary', () => {
  it('keeps init and the firebase/auth entry acyclic through a focused coordinator', () => {
    const initSource = readFileSync(join(entriesDir, 'init.ts'), 'utf8');
    const authSource = readFileSync(join(entriesDir, 'auth.ts'), 'utf8');
    const coordinatorSource = readFileSync(join(entriesDir, 'active-auth.ts'), 'utf8');

    expect(initSource).toContain("from './active-auth.js'");
    expect(initSource).not.toContain("from './auth.js'");
    expect(authSource).toContain("from './active-auth.js'");
    expect(coordinatorSource).not.toContain("from './auth.js'");
    expect(coordinatorSource).not.toContain("from './init.js'");
  });
});
