/**
 * The Cloud Storage rules engine: lint, simulate, and install. `parseFailure`'s
 * exact wording is `rules-engines/registry.test.ts`'s subject.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { STORAGE_RULES } from '../../../../src/bridge/surface/rules-engines/storage.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const SIGNED_IN_ONLY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function freshContext() {
  return createSurfaceContext(initializeSandbox());
}

describe('requestMethods', () => {
  it('evaluates the Firestore-style and the get/write style methods both', () => {
    expect([...STORAGE_RULES.requestMethods]).toEqual([
      'get',
      'list',
      'create',
      'update',
      'delete',
      'read',
      'write',
    ]);
  });
});

describe('lint', () => {
  it('fails when no rules are supplied and none are loaded', async () => {
    const result = await STORAGE_RULES.lint(freshContext(), undefined);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('No storage rules');
  });

  it('reports a parse error rather than throwing', async () => {
    const result = await STORAGE_RULES.lint(freshContext(), 'not rules at all {');
    expect(result.ok).toBe(false);
    expect((result.data as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('parses a supplied source with no errors', async () => {
    const result = await STORAGE_RULES.lint(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(true);
    expect((result.data as { errors: string[] }).errors).toEqual([]);
  });
});

describe('install', () => {
  it('rejects a source that does not parse', async () => {
    const result = await STORAGE_RULES.install(freshContext(), 'not rules at all {');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Storage rules did not parse');
  });

  it('installs a parsed source', async () => {
    const result = await STORAGE_RULES.install(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Storage rules installed.');
  });
});

describe('simulate', () => {
  it('fails when no rules are supplied and none are installed', async () => {
    const result = await STORAGE_RULES.simulate(freshContext(), {
      operation: 'get',
      path: 'uploads/note.txt',
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('No storage rules');
  });

  it('reports allowed or denied for the identity the request carries', async () => {
    const ctx = freshContext();
    await STORAGE_RULES.install(ctx, SIGNED_IN_ONLY_RULES);
    const anonymous = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
    });
    expect((anonymous.data as { allowed: boolean }).allowed).toBe(false);

    const signedIn = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
      uid: 'alice',
    });
    expect((signedIn.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('evaluates a supplied ruleset rather than the installed one when both are present', async () => {
    const ctx = freshContext();
    await STORAGE_RULES.install(ctx, OPEN_RULES);
    const denied = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
      rules: SIGNED_IN_ONLY_RULES,
    });
    expect((denied.data as { allowed: boolean }).allowed).toBe(false);
  });
});
