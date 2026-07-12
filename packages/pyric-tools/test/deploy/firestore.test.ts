/**
 * `@pyric/cli/deploy` Firestore unit tests. Reshaped to take
 * `ProjectScope` per F3.
 *
 * Network calls are stubbed via `fetch` mocks. Integration against
 * the live REST APIs is a separate test pass that needs OAuth tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  firestore,
  recipes,
  AdminApiError,
  type ProjectScope,
  type IndexesConfig,
} from '../../src/deploy/index.js';

const originalFetch = globalThis.fetch;

interface FetchCall { url: string; init: RequestInit | undefined }

function installFetchMock(responses: Response[]): { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Fetch mock ran out of queued responses (called ${url})`);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

const scope: ProjectScope = { projectId: 'p', resolveToken: async () => 'tkn' };

const { pyricSessions } = recipes;

// ─── firestore.rules.inject ─────────────────────────────────────────

describe('firestore.rules.inject', () => {
  it('inserts the snippet inside the documents { … } block', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth.uid == uid;
    }
  }
}`;
    const merged = firestore.rules.inject(source, pyricSessions.snippet, pyricSessions.marker);
    expect(merged).not.toBeNull();
    expect(merged).toContain('match /pyric_sessions/');
    expect(merged).toContain('match /users/{uid}');
  });

  it('returns null when the marker is already present (no-op)', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${pyricSessions.snippet}
  }
}`;
    expect(firestore.rules.inject(source, pyricSessions.snippet, pyricSessions.marker)).toBeNull();
  });

  it('throws when the documents { … } block is missing', () => {
    expect(() => firestore.rules.inject('rules_version = "2"; service cloud.firestore {}', pyricSessions.snippet, pyricSessions.marker)).toThrow(/Could not locate/);
  });
});

// ─── firestore.rules.fetch ──────────────────────────────────────────

describe('firestore.rules.fetch', () => {
  it('returns the ruleset source on a successful round-trip', async () => {
    const SOURCE = `rules_version = '2';\nservice cloud.firestore {…}`;
    installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: SOURCE }] } }),
    ]);
    const source = await firestore.rules.fetch(scope);
    expect(source).toBe(SOURCE);
  });

  it('returns null when the release does not exist yet (404)', async () => {
    installFetchMock([textResponse(404, 'not found')]);
    expect(await firestore.rules.fetch(scope)).toBeNull();
  });

  it('throws AdminApiError on non-404 release failures', async () => {
    installFetchMock([textResponse(403, 'forbidden')]);
    await expect(firestore.rules.fetch(scope)).rejects.toBeInstanceOf(AdminApiError);
  });

  it('threads the resolved token into the Authorization header (F4)', async () => {
    const customScope: ProjectScope = { projectId: 'p', resolveToken: async () => 'my-token' };
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: '' }] } }),
    ]);
    await firestore.rules.fetch(customScope);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });
});

// ─── firestore.rules.deploy ─────────────────────────────────────────

describe('firestore.rules.deploy', () => {
  it('creates a ruleset then PATCHes the release', async () => {
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'projects/p/rulesets/new' }),
      jsonResponse(200, { name: 'projects/p/releases/cloud.firestore' }),
    ]);
    await firestore.rules.deploy(scope, 'rules_version = "2";');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://firebaserules.googleapis.com/v1/projects/p/rulesets');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[1].url).toContain('/projects/p/releases/cloud.firestore');
    expect(calls[1].init?.method).toBe('PATCH');
  });

  it('throws AdminApiError when the create step fails', async () => {
    installFetchMock([textResponse(401, 'unauthorized')]);
    await expect(firestore.rules.deploy(scope, 'rules_version = "2";')).rejects.toBeInstanceOf(AdminApiError);
  });

  it('throws AdminApiError when the release-update step fails', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'projects/p/rulesets/new' }),
      textResponse(500, 'server error'),
    ]);
    await expect(firestore.rules.deploy(scope, 'rules_version = "2";')).rejects.toBeInstanceOf(AdminApiError);
  });

  it('falls back to POST releases when PATCH returns 404 (first deploy)', async () => {
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'projects/p/rulesets/new' }),
      textResponse(404, 'release not found'),
      jsonResponse(200, { name: 'projects/p/releases/cloud.firestore' }),
    ]);
    await firestore.rules.deploy(scope, 'rules_version = "2";');
    expect(calls).toHaveLength(3);
    expect(calls[1].init?.method).toBe('PATCH');
    expect(calls[2].url).toBe('https://firebaserules.googleapis.com/v1/projects/p/releases');
    expect(calls[2].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[2].init?.body));
    expect(body).toEqual({
      name: 'projects/p/releases/cloud.firestore',
      rulesetName: 'projects/p/rulesets/new',
    });
  });

  it('throws AdminApiError when the POST-fallback create step fails', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'projects/p/rulesets/new' }),
      textResponse(404, 'release not found'),
      textResponse(403, 'forbidden'),
    ]);
    await expect(firestore.rules.deploy(scope, 'rules_version = "2";')).rejects.toBeInstanceOf(AdminApiError);
  });
});

// ─── firestore.rules.check ──────────────────────────────────────────

describe('firestore.rules.check', () => {
  it('returns configured when the marker is present', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: pyricSessions.freshTemplate }] } }),
    ]);
    expect(await firestore.rules.check(scope, pyricSessions.marker)).toEqual({ state: 'configured' });
  });

  it('returns not-configured when the marker is missing', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: 'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { allow read: if false; } }' }] } }),
    ]);
    expect(await firestore.rules.check(scope, pyricSessions.marker)).toEqual({ state: 'not-configured' });
  });

  it('returns no-rules-yet on 404', async () => {
    installFetchMock([textResponse(404, 'not found')]);
    expect(await firestore.rules.check(scope, pyricSessions.marker)).toEqual({ state: 'no-rules-yet' });
  });

  it('returns check-failed on transport errors', async () => {
    installFetchMock([textResponse(500, 'boom')]);
    const result = await firestore.rules.check(scope, pyricSessions.marker);
    expect(result.state).toBe('check-failed');
  });
});

// ─── firestore.rules.ensure ─────────────────────────────────────────

describe('firestore.rules.ensure', () => {
  it('returns already-configured when the marker is present', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: pyricSessions.freshTemplate }] } }),
    ]);
    expect(await firestore.rules.ensure(scope, pyricSessions)).toEqual({ ok: true, status: 'already-configured' });
  });

  it('merges into existing rules and deploys when the marker is missing', async () => {
    const existing = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} { allow read: if true; }
  }
}`;
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: existing }] } }),
      jsonResponse(200, { name: 'projects/p/rulesets/new' }),
      jsonResponse(200, { name: 'projects/p/releases/cloud.firestore' }),
    ]);
    const result = await firestore.rules.ensure(scope, pyricSessions);
    expect(result).toEqual({ ok: true, status: 'merged' });
    const body = JSON.parse(calls[2].init?.body as string);
    expect(body.source.files[0].content).toContain('match /users/{uid}');
    expect(body.source.files[0].content).toContain('match /pyric_sessions/');
  });

  it('writes a fresh ruleset when the project has no rules yet', async () => {
    const { calls } = installFetchMock([
      textResponse(404, 'not found'),
      jsonResponse(200, { name: 'projects/p/rulesets/new' }),
      jsonResponse(200, { name: 'projects/p/releases/cloud.firestore' }),
    ]);
    const result = await firestore.rules.ensure(scope, pyricSessions);
    expect(result).toEqual({ ok: true, status: 'fresh' });
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.source.files[0].content).toBe(pyricSessions.freshTemplate);
  });

  it('returns permission-denied on 401/403', async () => {
    installFetchMock([textResponse(403, 'forbidden')]);
    const result = await firestore.rules.ensure(scope, pyricSessions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('permission-denied');
  });

  it('returns merge-failed when inject cannot find the documents block', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'r1', rulesetName: 'projects/p/rulesets/abc' }),
      jsonResponse(200, { name: 'projects/p/rulesets/abc', source: { files: [{ name: 'firestore.rules', content: 'rules_version = "2"; service cloud.firestore {}' }] } }),
    ]);
    const result = await firestore.rules.ensure(scope, pyricSessions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('merge-failed');
  });

  it('returns unknown for other failure modes', async () => {
    installFetchMock([textResponse(500, 'server error')]);
    const result = await firestore.rules.ensure(scope, pyricSessions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown');
  });
});

// ─── firestore.databases.provision ──────────────────────────────────

describe('firestore.databases.provision', () => {
  it('returns already-exists when the database probe succeeds', async () => {
    installFetchMock([jsonResponse(200, { name: 'projects/p/databases/(default)' })]);
    const result = await firestore.databases.provision(scope);
    expect(result).toEqual({ ok: true, status: 'already-exists' });
  });

  it('creates the database when the probe returns 404', async () => {
    const { calls } = installFetchMock([
      textResponse(404, 'not found'),
      jsonResponse(200, { name: 'projects/p/operations/abc' }),
    ]);
    const result = await firestore.databases.provision(scope);
    expect(result.ok).toBe(true);
    if (result.ok && result.status === 'created') {
      expect(result.operationName).toBe('projects/p/operations/abc');
    }
    expect(calls[1].url).toContain('databases?databaseId=(default)');
    expect(calls[1].init?.method).toBe('POST');
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.locationId).toBe('nam5');
    expect(body.type).toBe('FIRESTORE_NATIVE');
  });

  it('honors locationId + databaseId overrides', async () => {
    const { calls } = installFetchMock([
      textResponse(404, 'not found'),
      jsonResponse(200, { name: 'projects/p/operations/abc' }),
    ]);
    await firestore.databases.provision(scope, { locationId: 'us-east4', databaseId: 'analytics' });
    expect(calls[1].url).toContain('databaseId=analytics');
    expect(calls[0].url).toContain('/databases/analytics');
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.locationId).toBe('us-east4');
  });

  it('returns permission-denied on 401/403 from the probe', async () => {
    installFetchMock([textResponse(403, 'forbidden')]);
    const result = await firestore.databases.provision(scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('permission-denied');
  });

  it('returns unknown on create failures other than 401/403', async () => {
    installFetchMock([textResponse(404, 'not found'), textResponse(500, 'server error')]);
    const result = await firestore.databases.provision(scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown');
  });
});

// ─── firestore.indexes.create ───────────────────────────────────────

describe('firestore.indexes.create', () => {
  const ENTRY = {
    collectionGroup: 'tickets',
    queryScope: 'COLLECTION' as const,
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' as const },
      { fieldPath: 'priority', order: 'DESCENDING' as const },
    ],
  };

  it('POSTs the entry body to the collection-group indexes endpoint and returns the LRO handle', async () => {
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'projects/p/databases/(default)/operations/op1', done: false }),
    ]);
    const op = await firestore.indexes.create(scope, ENTRY);
    expect(op.name).toBe('projects/p/databases/(default)/operations/op1');
    expect(calls[0].url).toBe(
      'https://firestore.googleapis.com/v1/projects/p/databases/(default)/collectionGroups/tickets/indexes',
    );
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.collectionGroup).toBeUndefined();
    expect(body.queryScope).toBe('COLLECTION');
    expect(body.fields).toEqual(ENTRY.fields);
  });

  it('honors the databaseId option', async () => {
    const { calls } = installFetchMock([
      jsonResponse(200, { name: 'projects/p/databases/analytics/operations/op1' }),
    ]);
    await firestore.indexes.create(scope, ENTRY, { databaseId: 'analytics' });
    expect(calls[0].url).toContain('/databases/analytics/');
  });

  it('throws AdminApiError carrying the HTTP status on non-2xx', async () => {
    installFetchMock([textResponse(409, '{"error":{"code":409,"message":"already exists"}}')]);
    let err: unknown;
    try { await firestore.indexes.create(scope, ENTRY); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).status).toBe(409);
  });
});

// ─── firestore.indexes.deployAll ────────────────────────────────────

describe('firestore.indexes.deployAll', () => {
  const CFG: IndexesConfig = {
    indexes: [
      {
        collectionGroup: 'tickets',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'status', order: 'ASCENDING' },
          { fieldPath: 'priority', order: 'DESCENDING' },
        ],
      },
      {
        collectionGroup: 'logs',
        queryScope: 'COLLECTION_GROUP',
        fields: [{ fieldPath: 'createdAt', order: 'DESCENDING' }],
      },
    ],
  };

  it('returns ok with per-index outcomes when every create succeeds', async () => {
    installFetchMock([
      jsonResponse(200, { name: 'op1' }),
      jsonResponse(200, { name: 'op2' }),
    ]);
    const result = await firestore.indexes.deployAll(scope, CFG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operationsStarted.map((o) => o.name)).toEqual(['op1', 'op2']);
    expect(result.alreadyExists).toBe(0);
    expect(result.perIndex.map((p) => p.status)).toEqual(['started', 'started']);
  });

  it('buckets 409s as already-exists and keeps going', async () => {
    installFetchMock([
      textResponse(409, '{"error":{"message":"already exists"}}'),
      jsonResponse(200, { name: 'op2' }),
    ]);
    const result = await firestore.indexes.deployAll(scope, CFG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExists).toBe(1);
    expect(result.perIndex[0].status).toBe('already-exists');
    expect(result.perIndex[1].status).toBe('started');
  });

  it('aborts the batch on 403 and returns permission-denied with partial data', async () => {
    installFetchMock([textResponse(403, 'forbidden')]);
    const result = await firestore.indexes.deployAll(scope, CFG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('permission-denied');
    expect(result.partial?.operationsStarted).toEqual([]);
  });

  it('marks 400-class entries as failed but processes the rest', async () => {
    installFetchMock([
      textResponse(400, '{"error":{"message":"bad spec"}}'),
      jsonResponse(200, { name: 'op2' }),
    ]);
    const result = await firestore.indexes.deployAll(scope, CFG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('create-failed');
    expect(result.partial?.perIndex[0].status).toBe('failed');
    expect(result.partial?.perIndex[1].status).toBe('started');
  });

  it('returns invalid-config when the input config is malformed', async () => {
    const result = await firestore.indexes.deployAll(scope, {
      indexes: [{
        collectionGroup: '',
        queryScope: 'COLLECTION',
        fields: [{ fieldPath: 'x', order: 'ASCENDING' }],
      }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid-config');
  });

  it('rejects field entries without exactly one of order / arrayConfig / vectorConfig', async () => {
    const result = await firestore.indexes.deployAll(scope, {
      indexes: [{
        collectionGroup: 'logs',
        queryScope: 'COLLECTION',
        fields: [{ fieldPath: 'x' }],
      }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid-config');
  });
});

// ─── firestore.indexes.getStatus ────────────────────────────────────

describe('firestore.indexes.getStatus', () => {
  const OP_NAME = 'projects/p/databases/(default)/collectionGroups/tickets/indexes/idx/operations/op1';

  it('returns CREATING while the LRO is in flight', async () => {
    installFetchMock([jsonResponse(200, { name: OP_NAME, done: false })]);
    const result = await firestore.indexes.getStatus(scope, OP_NAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe('CREATING');
  });

  it('returns READY with the index summary when the LRO completes successfully', async () => {
    installFetchMock([
      jsonResponse(200, {
        name: OP_NAME,
        done: true,
        response: {
          name: 'projects/p/.../indexes/idx',
          queryScope: 'COLLECTION',
          fields: [
            { fieldPath: 'status', order: 'ASCENDING' },
            { fieldPath: 'priority', order: 'DESCENDING' },
          ],
          state: 'READY',
        },
      }),
    ]);
    const result = await firestore.indexes.getStatus(scope, OP_NAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe('READY');
    if (result.state !== 'READY') return;
    expect(result.index?.fields).toEqual([
      { fieldPath: 'status', order: 'ASCENDING', arrayConfig: undefined },
      { fieldPath: 'priority', order: 'DESCENDING', arrayConfig: undefined },
    ]);
  });

  it('returns NOT_FOUND when the operation has been garbage-collected', async () => {
    installFetchMock([textResponse(404, 'gone')]);
    const result = await firestore.indexes.getStatus(scope, OP_NAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe('NOT_FOUND');
  });

  it('returns build-failed when the LRO completed with an error', async () => {
    installFetchMock([
      jsonResponse(200, {
        name: OP_NAME,
        done: true,
        error: { code: 13, message: 'internal failure' },
      }),
    ]);
    const result = await firestore.indexes.getStatus(scope, OP_NAME);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('build-failed');
  });

  it('returns permission-denied on 403', async () => {
    installFetchMock([textResponse(403, 'forbidden')]);
    const result = await firestore.indexes.getStatus(scope, OP_NAME);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('permission-denied');
  });

  it('rejects an empty operationName up front without making a request', async () => {
    const { calls } = installFetchMock([]);
    const result = await firestore.indexes.getStatus(scope, '');
    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
