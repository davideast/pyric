/**
 * The Cloud Storage rules engine: lint, simulate, and install. `compileFailure`'s
 * exact wording is `rules-engines/registry.test.ts`'s subject.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { deleteObject, getMetadata, getStorageSandbox, ref, updateMetadata, uploadBytes } from 'pyric/storage';
import { compileStorageRules } from 'pyric/storage/internal';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import { METHODS_BY_KEY } from '../../../../src/bridge/surface/index.js';
import { STORAGE_RULES } from '../../../../src/bridge/surface/rules-engines/storage.js';

const TIME_GATED_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.time > timestamp.date(2026, 1, 1);
    }
  }
}`;

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

  it('passes a source that checks the caller and the upload with no errors', async () => {
    const checked = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.uid == uid && request.resource.size < 1024 * 1024;
    }
  }
}`;
    const result = await STORAGE_RULES.lint(freshContext(), checked);
    expect(result.ok).toBe(true);
    expect((result.data as { errors: string[] }).errors).toEqual([]);
    expect(result.summary).toBe('Storage rules compiled with no lint errors. Warnings: SEC-4.');
  });

  it('reports the shared linter\'s security findings for public read and write (ST-H3-7)', async () => {
    const result = await STORAGE_RULES.lint(freshContext(), OPEN_RULES);
    expect(result.ok).toBe(false);
    const issues = (result.data as { issues: Array<{ code: string }> }).issues;
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('SEC-1');
    expect(codes).toContain('SEC-2');
    expect(codes).toContain('SEC-5');
    expect(result.summary).toContain('SEC-1');
  });

  it('lints the installed source when none is supplied', async () => {
    const ctx = freshContext();
    await STORAGE_RULES.install(ctx, OPEN_RULES);
    const result = await STORAGE_RULES.lint(ctx, undefined);
    expect(result.ok).toBe(false);
    const codes = (result.data as { issues: Array<{ code: string }> }).issues.map((issue) => issue.code);
    expect(codes).toContain('SEC-1');
  });
});

describe('install', () => {
  it('rejects a source that does not parse', async () => {
    const result = await STORAGE_RULES.install(freshContext(), 'not rules at all {');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Storage rules did not parse');
  });

  it('states a parse failure that ends in a period without doubling it', () => {
    const problem = STORAGE_RULES.compileFailure(
      "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { allow read: if true;",
    );
    expect(problem?.body).toEndWith("expected '}' to close the match block opened at line 2.");
    expect(problem?.body).not.toContain('..');
  });

  it('rejects a source past production\'s compile limits with production\'s message', async () => {
    const deep = OPEN_RULES.replace('if true', `if ${'('.repeat(300)}true${')'.repeat(300)}`);
    const result = await STORAGE_RULES.install(freshContext(), deep);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Storage rules did not compile: Line 5: Expression is too complex to evaluate safely.');
    const problem = STORAGE_RULES.compileFailure(deep);
    expect(problem?.body).toBe('rules did not compile: Line 5: Expression is too complex to evaluate safely.');
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

  it('flips a request.time-gated rule by an explicit requestTime', async () => {
    const ctx = freshContext();
    const gateInstant = Date.parse('2026-01-01T00:00:00.000Z');
    await STORAGE_RULES.install(ctx, TIME_GATED_RULES);
    const before = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
      requestTime: new Date(gateInstant - 60_000).toISOString(),
    });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);
    const after = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
      requestTime: new Date(gateInstant + 60_000).toISOString(),
    });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('defaults request.time to the sandbox clock when requestTime is omitted', async () => {
    const ctx = freshContext();
    const gateInstant = Date.parse('2026-01-01T00:00:00.000Z');
    await STORAGE_RULES.install(ctx, TIME_GATED_RULES);
    getClock(ctx.sandbox).set(gateInstant - 60_000);
    const before = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
    });
    expect((before.data as { allowed: boolean }).allowed).toBe(false);
    getClock(ctx.sandbox).set(gateInstant + 60_000);
    const after = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'uploads/note.txt',
    });
    expect((after.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('populates resource from existing stored object metadata in the sandbox (ST-CON-1)', async () => {
    const sandbox = initializeSandbox();
    const ctx = createSurfaceContext(sandbox);
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow create: if request.auth != null;
      allow get: if resource != null && resource.metadata.owner == request.auth.uid;
    }
  }
}`;
    await STORAGE_RULES.install(ctx, rules);
    const authedStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));
    await uploadBytes(ref(authedStorage, 'docs/readme.txt'), new TextEncoder().encode('hello world'), {
      contentType: 'text/plain',
      customMetadata: { owner: 'alice' },
    });

    const simAlice = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'docs/readme.txt',
      uid: 'alice',
    });
    expect((simAlice.data as { allowed: boolean }).allowed).toBe(true);

    const simBob = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'docs/readme.txt',
      uid: 'bob',
    });
    expect((simBob.data as { allowed: boolean }).allowed).toBe(false);
  });

  it('passes request.data through rules.simulate and constructs request.resource for Storage writes (ST-CON-2)', async () => {
    const ctx = freshContext();
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow create: if request.resource != null
        && request.resource.contentType == 'image/png'
        && request.resource.size < 1024
        && request.resource.metadata.owner == request.auth.uid;
    }
  }
}`;
    await STORAGE_RULES.install(ctx, rules);
    const simulateMethod = METHODS_BY_KEY.get('rules.simulate')!;
    const simResult = await simulateMethod.handler(
      {
        service: 'storage',
        operation: 'create',
        path: 'uploads/a.png',
        uid: 'alice',
        data: {
          contentType: 'image/png',
          size: 128,
          metadata: { owner: 'alice' },
        },
      },
      ctx,
    );
    expect(simResult.ok).toBe(true);
    expect((simResult.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('matches root bucket path b/{bucket}/o without trailing slash on empty or / path (ST-CON-3b)', async () => {
    const ctx = freshContext();
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    allow list: if request.auth != null;
    match /files/{file} {
      allow read: if true;
    }
  }
}`;
    await STORAGE_RULES.install(ctx, rules);
    const simRoot = await STORAGE_RULES.simulate(ctx, {
      operation: 'list',
      path: '/',
      uid: 'alice',
    });
    expect((simRoot.data as { allowed: boolean }).allowed).toBe(true);
  });

  it('evaluates rules_version = 2+modules imports across compileFailure, lint, and simulate (MOD-CON-1)', async () => {
    const ctx = freshContext();
    const moduleRules = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{name} {
      allow read: if isAuthenticated();
    }
  }
}`;
    await STORAGE_RULES.install(ctx, moduleRules);

    const simInstalled = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'files/test.txt',
      uid: 'alice',
    });
    expect((simInstalled.data as { allowed: boolean }).allowed).toBe(true);

    const simDraft = await STORAGE_RULES.simulate(ctx, {
      operation: 'get',
      path: 'files/test.txt',
      uid: 'alice',
      rules: moduleRules,
    });
    expect((simDraft.data as { allowed: boolean }).allowed).toBe(true);

    const brokenModuleRules = `rules_version = '2+modules';
import { doesNotExist } from 'auth';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{name} {
      allow read: if doesNotExist();
    }
  }
}`;
    expect(STORAGE_RULES.compileFailure(brokenModuleRules)).not.toBeNull();
    const lintBroken = await STORAGE_RULES.lint(ctx, brokenModuleRules);
    expect(lintBroken.ok).toBe(false);
  });

  it('rejects invalid RE2 regex literals and import under rules_version = 2 at compile/install time (ST-CON-4)', async () => {
    const ctx = freshContext();
    const brokenRegexRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{file} {
      allow read: if file.matches("(");
    }
  }
}`;
    const regexInstall = await STORAGE_RULES.install(ctx, brokenRegexRules);
    expect(regexInstall.ok).toBe(false);

    const v2WithImport = `rules_version = '2';
import { isAuthenticated } from 'auth';
service firebase.storage {
  match /b/{bucket}/o {
    match /{file} {
      allow read: if isAuthenticated();
    }
  }
}`;
    expect(() => compileStorageRules(v2WithImport)).toThrow(/rules_version = '2\+modules'/);
    const v2Install = await STORAGE_RULES.install(ctx, v2WithImport);
    expect(v2Install.ok).toBe(false);
  });
});

/**
 * `request.resource` is built per verb, as the live planes build it
 * (ST-H2-5, ST-H2-6, ST-H3-2, ST-H3-3). Each expected verdict comes from the
 * same request made on the in-page plane in the same sandbox.
 */
describe('simulate request.resource by verb', () => {
  const OWNER_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow get, delete: if request.resource == null;
      allow create: if request.auth != null && request.resource.metadata.owner == request.auth.uid;
      allow update: if request.resource.size == 11;
    }
  }
}`;

  async function seeded() {
    const sandbox = initializeSandbox();
    const ctx = createSurfaceContext(sandbox);
    await STORAGE_RULES.install(ctx, OWNER_RULES);
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));
    await uploadBytes(ref(alice, 'docs/readme.txt'), new TextEncoder().encode('hello world'), {
      contentType: 'text/plain',
      customMetadata: { owner: 'alice' },
    });
    return { ctx, alice };
  }

  function allowedOf(result: { ok: boolean; data?: unknown }): boolean {
    expect(result.ok).toBe(true);
    return (result.data as { allowed: boolean }).allowed;
  }

  async function liveAllows(run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch {
      return false;
    }
  }

  it('builds a re-upload from the case data only, not the stored object (ST-H2-5)', async () => {
    const { ctx, alice } = await seeded();
    const live = await liveAllows(() =>
      uploadBytes(ref(alice, 'docs/readme.txt'), new TextEncoder().encode('again'), {
        contentType: 'text/plain',
      }),
    );
    expect(live).toBe(false);
    const simulated = await STORAGE_RULES.simulate(ctx, {
      operation: 'create',
      path: 'docs/readme.txt',
      uid: 'alice',
      data: { contentType: 'text/plain', size: 5 },
    });
    expect(allowedOf(simulated)).toBe(live);
  });

  it('gives an upload with no data the upload defaults', async () => {
    const rules = OPEN_RULES.replace(
      'allow read, write: if true;',
      "allow create: if request.resource.contentType == 'application/octet-stream' && request.resource.size == 0;",
    );
    const result = await STORAGE_RULES.simulate(freshContext(), { operation: 'create', path: 'a/b.bin', rules });
    expect(allowedOf(result)).toBe(true);
  });

  it('builds an update from the stored object even when no data is passed (ST-H3-2)', async () => {
    const { ctx, alice } = await seeded();
    const simulated = await STORAGE_RULES.simulate(ctx, {
      operation: 'update',
      path: 'docs/readme.txt',
      uid: 'alice',
    });
    const live = await liveAllows(() => updateMetadata(ref(alice, 'docs/readme.txt'), {}));
    expect(live).toBe(true);
    expect(allowedOf(simulated)).toBe(live);
  });

  it('patches the stored object with the case data on an update', async () => {
    const { ctx } = await seeded();
    const rules = OPEN_RULES.replace(
      'allow read, write: if true;',
      "allow update: if request.resource.contentType == 'text/markdown' && request.resource.metadata.owner == 'alice';",
    );
    const result = await STORAGE_RULES.simulate(ctx, {
      operation: 'update',
      path: 'docs/readme.txt',
      rules,
      data: { contentType: 'text/markdown' },
    });
    expect(allowedOf(result)).toBe(true);
  });

  for (const operation of ['get', 'list', 'delete'] as const) {
    it(`refuses data on a ${operation}, which carries no request.resource (ST-H2-6)`, async () => {
      const { ctx } = await seeded();
      const result = await STORAGE_RULES.simulate(ctx, {
        operation,
        path: 'docs/readme.txt',
        uid: 'alice',
        data: { size: 5 },
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toContain(`a ${operation} request carries no request.resource; remove 'data'`);
    });
  }

  it('evaluates a get and a delete with no request.resource, as the live planes do', async () => {
    const { ctx, alice } = await seeded();
    const liveGet = await liveAllows(() => getMetadata(ref(alice, 'docs/readme.txt')));
    const simGet = await STORAGE_RULES.simulate(ctx, { operation: 'get', path: 'docs/readme.txt', uid: 'alice' });
    expect(allowedOf(simGet)).toBe(liveGet);
    const simDelete = await STORAGE_RULES.simulate(ctx, {
      operation: 'delete',
      path: 'docs/readme.txt',
      uid: 'alice',
    });
    const liveDelete = await liveAllows(() => deleteObject(ref(alice, 'docs/readme.txt')));
    expect(allowedOf(simDelete)).toBe(liveDelete);
  });

  it('reads a numeric string size as its number (ST-H3-3)', async () => {
    const rules = OPEN_RULES.replace('allow read, write: if true;', 'allow create: if request.resource.size > 1000;');
    const result = await STORAGE_RULES.simulate(freshContext(), {
      operation: 'create',
      path: 'a/b.bin',
      rules,
      data: { size: '999999' },
    });
    expect(allowedOf(result)).toBe(true);
  });

  it('refuses a misspelled data field, naming it (ST-H3-3)', async () => {
    const result = await STORAGE_RULES.simulate(freshContext(), {
      operation: 'create',
      path: 'a/b.bin',
      rules: OPEN_RULES,
      data: { sise: 10 },
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('data.sise is not a field of request.resource');
  });

  it('refuses a wrong-typed data field, naming it (ST-H3-3)', async () => {
    const ctx = freshContext();
    const wrong: Array<[string, Record<string, unknown>]> = [
      ['data.size', { size: true }],
      ['data.contentType', { contentType: 5 }],
      ['data.metadata.owner', { metadata: { owner: 5 } }],
    ];
    for (const [field, data] of wrong) {
      const result = await STORAGE_RULES.simulate(ctx, {
        operation: 'create',
        path: 'a/b.bin',
        rules: OPEN_RULES,
        data,
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toContain(field);
    }
  });
});
