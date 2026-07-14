import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const conventions = readFileSync(
  resolve(import.meta.dir, '../../../../docs/code-conventions.md'),
  'utf8',
);

describe('app architecture conventions', () => {
  it('documents the FirebaseApp registry and neutral runtime-adapter seam', () => {
    expect(conventions).not.toContain('PyricApp');
    expect(conventions).toContain('FirebaseApp registry');
    expect(conventions).toContain('sandbox/internal/client-app');
    expect(conventions).toContain('surfaces do not import `app`');
  });

  it('states a ratified convention and records the two accepted structural follow-ups', () => {
    expect(conventions).not.toContain('DRAFT for owner ratification');
    expect(conventions).not.toContain('foundational unratified convention');
    expect(conventions).toContain('decisions/0007-firestore-runtime-splits-follow-up.md');
    expect(conventions).toContain('sandbox/firestore/local-environment.ts');
    expect(conventions).toContain('sandbox/internal/sandbox-impl.ts');
  });
});
