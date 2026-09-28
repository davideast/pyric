/**
 * The Firestore rules engine: lint, simulate, install, and the denial trace
 * `explainFirestoreDenial` builds from the same simulation. `compileFailure`'s
 * exact wording is `rules-engines/registry.test.ts`'s subject.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';

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

/** Twelve `let` bindings in one function, one more than production compiles. */
const OVER_LET_LIMIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function g() {
${Array.from({ length: 12 }, (_, i) => `      let v${i} = ${i};`).join('\n')}
      return request.auth != null && v0 == 0;
    }
    match /{document=**} {
      allow read, write: if g();
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

  it('rejects a source past production\'s compile limits with production\'s message and keeps the active rules', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, OPEN_RULES);
    const result = await FIRESTORE_RULES.install(ctx, OVER_LET_LIMIT);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(
      'Firestore rules did not compile: Line 17: Maximum allowed variable count of 10 for a given function has been reached.',
    );
    const open = await FIRESTORE_RULES.simulate(ctx, { operation: 'get', path: 'posts/p1' });
    expect((open.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('rejects 300 nested parentheses as too complex rather than crashing', async () => {
    const deep = OPEN_RULES.replace('if true', `if ${'('.repeat(300)}true${')'.repeat(300)}`);
    const result = await FIRESTORE_RULES.install(freshContext(), deep);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Expression is too complex to evaluate safely.');
  });

  it('lints a source past the compile limits as findings rather than refusing it', async () => {
    const result = await FIRESTORE_RULES.lint(freshContext(), OVER_LET_LIMIT);
    expect(result.summary).not.toContain('did not compile');
    expect(JSON.stringify(result.data)).toContain('LET_LIMIT');
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

  it('flips a request.time-gated rule by an explicit requestTime', async () => {
    const ctx = freshContext();
    const gateInstant = Date.parse('2026-01-01T00:00:00.000Z');
    const gated = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time > timestamp.date(2026, 1, 1);
    }
  }
}`;
    await FIRESTORE_RULES.install(ctx, gated);
    const before = await FIRESTORE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'posts/p1',
      requestTime: new Date(gateInstant - 60_000).toISOString(),
    });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);
    const after = await FIRESTORE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'posts/p1',
      requestTime: new Date(gateInstant + 60_000).toISOString(),
    });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('defaults request.time to the sandbox clock when requestTime is omitted', async () => {
    const ctx = freshContext();
    const gateInstant = Date.parse('2026-01-01T00:00:00.000Z');
    const gated = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time > timestamp.date(2026, 1, 1);
    }
  }
}`;
    await FIRESTORE_RULES.install(ctx, gated);
    getClock(ctx.sandbox).set(gateInstant - 60_000);
    const before = await FIRESTORE_RULES.simulate(ctx, { operation: 'get', path: 'posts/p1' });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);
    getClock(ctx.sandbox).set(gateInstant + 60_000);
    const after = await FIRESTORE_RULES.simulate(ctx, { operation: 'get', path: 'posts/p1' });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
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

describe('the path form the console shows', () => {
  const OWNED_ORDERS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{orderId} {
      allow read: if true;
    }
  }
}`;

  it('answers the full resource name with the document-relative verdict', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, OWNED_ORDERS_RULES);
    const result = await FIRESTORE_RULES.simulate(ctx, {
      operation: 'get',
      path: '/databases/(default)/documents/orders/o2',
    });
    expect(result.ok).toBe(true);
    expect((result.data as { allowed: boolean }).allowed).toBe(true);
    expect(result.summary).not.toContain('No match block');
  });

  it('leads with the reason and names the path form when nothing matches', async () => {
    const ctx = freshContext();
    await FIRESTORE_RULES.install(ctx, OWNED_ORDERS_RULES);
    const result = await FIRESTORE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'invoices/i1',
    });
    expect(result.ok).toBe(true);
    expect(result.summary.startsWith("No match block found for path 'invoices/i1'")).toBe(true);
    expect(result.summary).toContain('get invoices/i1: DENY');
    expect((result.data as { pathForm?: string }).pathForm).toContain('document-relative');
  });
});
