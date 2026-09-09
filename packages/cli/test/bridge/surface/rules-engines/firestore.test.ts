/**
 * The Firestore rules engine: lint, simulate, install, and the denial trace
 * `explainFirestoreDenial` builds from the same simulation. `parseFailure`'s
 * exact wording is `rules-engines/registry.test.ts`'s subject.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import {
  explainFirestoreDenial,
  FIRESTORE_RULES,
} from '../../../../src/bridge/surface/rules-engines/firestore.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const SIGNED_IN_ONLY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function freshContext() {
  return createSurfaceContext(initializeSandbox());
}

describe('requestMethods', () => {
  it('evaluates get, list, create, update, and delete', () => {
    expect([...FIRESTORE_RULES.requestMethods]).toEqual([
      'get',
      'list',
      'create',
      'update',
      'delete',
    ]);
  });
});

describe('lint', () => {
  it('lints the active rules when none are supplied', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, SIGNED_IN_ONLY_RULES);
    const result = await FIRESTORE_RULES.lint(ctx, undefined);
    expect(result.ok).toBe(true);
  });

  it('lints a supplied source rather than the active one', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, SIGNED_IN_ONLY_RULES);
    const result = await FIRESTORE_RULES.lint(ctx, OPEN_RULES);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('error');
  });
});

describe('install', () => {
  it('rejects a source that does not parse', async () => {
    const result = await FIRESTORE_RULES.install(freshContext(), 'not rules at all {');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Firestore rules did not parse');
  });

  it('installs a parsed source', async () => {
    const result = await FIRESTORE_RULES.install(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Firestore rules installed.');
  });
});

describe('simulate', () => {
  it('reports ALLOW or DENY for the identity the request carries', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, SIGNED_IN_ONLY_RULES);
    const anonymous = await FIRESTORE_RULES.simulate(ctx, { operation: 'get', path: 'posts/p1' });
    expect(anonymous.ok).toBe(true);
    expect((anonymous.data as { allowed: boolean }).allowed).toBe(false);

    const signedIn = await FIRESTORE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'posts/p1',
      uid: 'alice',
    });
    expect((signedIn.data as { allowed: boolean }).allowed).toBe(true);
  });
});

describe('explainFirestoreDenial', () => {
  it('states allowed for a request the rules allow', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, OPEN_RULES);
    const result = await explainFirestoreDenial(ctx, { operation: 'get', path: 'posts/p1' });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('is allowed for this identity');
  });

  it('states denied for a request the rules deny', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, SIGNED_IN_ONLY_RULES);
    const result = await explainFirestoreDenial(ctx, { operation: 'get', path: 'posts/p1' });
    expect(result.summary).toContain('is denied for this identity');
  });
});
