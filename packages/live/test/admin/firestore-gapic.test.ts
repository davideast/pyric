import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { Duplex, Readable } from 'node:stream';
import type { LiveCallRecord, LiveObserver } from '../../src/observe.js';
import {
  assertGapicPayloadAllowed,
  patchFirestoreGapicClients,
} from '../../src/admin/firestore-gapic.js';
import { isAdminMethodGated, runInsideAdminCall } from '../../src/admin/patch.js';
import { adminProjectGate, failClosedGate } from '../../src/admin/project-gate.js';

const HOST_PROJECT = 'org-alpha';

function errorCodeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err: unknown) {
    return (err as { code?: string })?.code;
  }
}

class CustomGapicRequest {
  readonly name?: string;
  readonly parent?: string;
  readonly databaseId?: string;
  readonly writes?: unknown[];
  constructor(fields: { name?: string; parent?: string; databaseId?: string; writes?: unknown[] }) {
    this.name = fields.name;
    this.parent = fields.parent;
    this.databaseId = fields.databaseId;
    this.writes = fields.writes;
  }
}

class GetterGapicRequest {
  readonly #target: string;
  readonly #dbId?: string;
  constructor(target: string, dbId?: string) {
    this.#target = target;
    this.#dbId = dbId;
  }
  get name(): string {
    return this.#target;
  }
  get databaseId(): string | undefined {
    return this.#dbId;
  }
}

describe('firestore-gapic', () => {
  const observer: LiveObserver = Object.assign(
    (_record: LiveCallRecord) => undefined,
    { client: 'node' as const, hostProjectId: HOST_PROJECT },
  );

  it('validates GAPIC resource strings across plain, non-plain, getter, inherited, container, cyclic, and protobufjs payloads', () => {
    expect(() =>
      assertGapicPayloadAllowed(
        [{ parent: `projects/${HOST_PROJECT}/databases/(default)/documents` }],
        observer,
      ),
    ).not.toThrow();

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [{ name: 'projects/org-beta/databases/(default)/documents/items/1' }],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [{ writes: [{ update: { name: `projects/${HOST_PROJECT}/databases/analytics-db/documents/items/1` } }] }],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [{ parent: `projects/${HOST_PROJECT}`, databaseId: 'secondary-db' }],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    // Non-plain class instances (cross-project, named database path, and named databaseId field).
    expect(() =>
      assertGapicPayloadAllowed(
        [new CustomGapicRequest({ name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1` })],
        observer,
      ),
    ).not.toThrow();

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [new CustomGapicRequest({ name: 'projects/org-beta/databases/(default)/documents/items/1' })],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [new CustomGapicRequest({ name: `projects/${HOST_PROJECT}/databases/other-db/documents/items/1` })],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [new CustomGapicRequest({ parent: `projects/${HOST_PROJECT}`, databaseId: 'secondary-db' })],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    // Prototype getters and prototype-inherited properties.
    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [new GetterGapicRequest('projects/org-beta/databases/(default)/documents/items/1')],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    expect(
      errorCodeOf(() =>
        assertGapicPayloadAllowed(
          [new GetterGapicRequest(`projects/${HOST_PROJECT}/databases/(default)/documents/items/1`, 'secondary-db')],
          observer,
        ),
      ),
    ).toBe('PYRIC_LIVE_REFUSED');

    const inheritedReq = Object.create({
      name: 'projects/org-beta/databases/(default)/documents/items/1',
    }) as object;
    expect(errorCodeOf(() => assertGapicPayloadAllowed([inheritedReq], observer))).toBe('PYRIC_LIVE_REFUSED');

    // Map and Set containers, plus binary/built-in skips and cyclic references.
    const mapReq = new Map<string, unknown>([
      ['target', new Set(['projects/org-beta/databases/(default)/documents/items/1'])],
    ]);
    expect(errorCodeOf(() => assertGapicPayloadAllowed([mapReq], observer))).toBe('PYRIC_LIVE_REFUSED');

    const safeCyclic: Record<string, unknown> = {
      name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1`,
      bytes: Buffer.from('projects/org-beta/databases/other-db/documents/items/1'),
      view: new Uint8Array([1, 2, 3]),
      createdAt: new Date(),
      pattern: /projects\/org-beta/,
    };
    safeCyclic.self = safeCyclic;
    expect(() => assertGapicPayloadAllowed([safeCyclic], observer)).not.toThrow();

    const badCyclic: Record<string, unknown> = {
      parent: `projects/${HOST_PROJECT}/databases/(default)/documents`,
    };
    badCyclic.self = badCyclic;
    badCyclic.nested = new CustomGapicRequest({
      name: 'projects/org-beta/databases/(default)/documents/items/1',
    });
    expect(errorCodeOf(() => assertGapicPayloadAllowed([badCyclic], observer))).toBe('PYRIC_LIVE_REFUSED');

    // Real protobufjs message instances created by @google-cloud/firestore's GAPIC protos.
    const requireHere = createRequire(import.meta.url);
    const firestoreMod = requireHere('firebase-admin/firestore') as {
      v1: {
        FirestoreClient: new (opts: Record<string, unknown>) => {
          _protos: {
            lookupType(name: string): { create(props: Record<string, unknown>): object };
          };
        };
      };
    };
    const protoClient = new firestoreMod.v1.FirestoreClient({
      projectId: HOST_PROJECT,
      fallback: 'rest',
      auth: {
        getProjectId: async () => HOST_PROJECT,
        getRequestHeaders: async () => ({}),
        getUniverseDomain: async () => 'googleapis.com',
      },
    });
    const GetDocumentRequest = protoClient._protos.lookupType('google.firestore.v1.GetDocumentRequest');

    const hostProtoReq = GetDocumentRequest.create({
      name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1`,
    });
    expect(() => assertGapicPayloadAllowed([hostProtoReq], observer)).not.toThrow();

    const otherProtoReq = GetDocumentRequest.create({
      name: 'projects/org-beta/databases/(default)/documents/items/1',
    });
    expect(errorCodeOf(() => assertGapicPayloadAllowed([otherProtoReq], observer))).toBe('PYRIC_LIVE_REFUSED');

    const namedDbProtoReq = GetDocumentRequest.create({
      name: `projects/${HOST_PROJECT}/databases/secondary-db/documents/items/1`,
    });
    expect(errorCodeOf(() => assertGapicPayloadAllowed([namedDbProtoReq], observer))).toBe('PYRIC_LIVE_REFUSED');
  });

  it('patches v1/v1beta1 GAPIC prototypes across unary, stream, async-iterable, and duplex methods while passing nested calls through', async () => {
    class FakeFirestoreClient {
      readonly _opts: { projectId: string };
      constructor(projectId: string) {
        this._opts = { projectId };
      }
      initialize(): void {}
      close(): Promise<void> {
        return Promise.resolve();
      }
      async getDocument(req: { name: string }): Promise<[{ name: string }]> {
        return [req];
      }
      runQuery(_req: { parent: string }): Readable {
        return Readable.from([{ document: 'd1' }], { objectMode: true });
      }
      async *listDocumentsAsync(_req: { parent: string }): AsyncGenerator<string> {
        yield 'items/1';
      }
      write(): Duplex {
        return new Duplex({
          objectMode: true,
          read() {},
          write(chunk, _enc, cb) {
            this.push(chunk);
            cb();
          },
        });
      }
    }

    class FakeFirestoreAdminClient {
      readonly _opts: { projectId: string };
      constructor(projectId: string) {
        this._opts = { projectId };
      }
      initialize(): void {}
      close(): Promise<void> {
        return Promise.resolve();
      }
      async exportDocuments(req: { name: string }): Promise<[unknown]> {
        return [req];
      }
    }

    const sdk = {
      v1: {
        FirestoreClient: FakeFirestoreClient,
        FirestoreAdminClient: FakeFirestoreAdminClient,
      },
      v1beta1: {
        FirestoreClient: FakeFirestoreClient,
      },
    };
    const gate = failClosedGate(adminProjectGate(HOST_PROJECT, () => undefined, {}), 'Firestore');
    patchFirestoreGapicClients(sdk, '/fake/firestore/index.js', '@google-cloud/firestore', gate, observer);

    expect(isAdminMethodGated(FakeFirestoreClient.prototype.initialize)).toBe(false);
    expect(isAdminMethodGated(FakeFirestoreClient.prototype.close)).toBe(false);
    expect(isAdminMethodGated(FakeFirestoreClient.prototype.getDocument)).toBe(true);
    expect(isAdminMethodGated(FakeFirestoreClient.prototype.runQuery)).toBe(true);
    expect(isAdminMethodGated(FakeFirestoreClient.prototype.listDocumentsAsync)).toBe(true);
    expect(isAdminMethodGated(FakeFirestoreClient.prototype.write)).toBe(true);
    expect(isAdminMethodGated(FakeFirestoreAdminClient.prototype.exportDocuments)).toBe(true);

    const hostClient = new FakeFirestoreClient(HOST_PROJECT);
    const otherClient = new FakeFirestoreClient('org-beta');

    expect(await hostClient.getDocument({ name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1` })).toEqual([
      { name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1` },
    ]);

    // Inside `runInsideAdminCall`, `runQuery` returns the raw stream directly without wrapping.
    const nestedStream = runInsideAdminCall(() =>
      hostClient.runQuery({ parent: `projects/${HOST_PROJECT}/databases/(default)/documents` }),
    );
    const nestedItems: unknown[] = [];
    for await (const item of nestedStream) nestedItems.push(item);
    expect(nestedItems).toEqual([{ document: 'd1' }]);

    const refusedOther = await otherClient
      .getDocument({ name: 'projects/org-beta/databases/(default)/documents/items/1' })
      .catch((err: unknown) => (err as { code?: string }).code);
    expect(refusedOther).toBe('PYRIC_LIVE_REFUSED');

    const refusedHostPayload = await hostClient
      .getDocument({ name: 'projects/org-beta/databases/(default)/documents/items/1' })
      .catch((err: unknown) => (err as { code?: string }).code);
    expect(refusedHostPayload).toBe('PYRIC_LIVE_REFUSED');

    const refusedNonPlain = await hostClient
      .getDocument(new CustomGapicRequest({ name: 'projects/org-beta/databases/(default)/documents/items/1' }) as { name: string })
      .catch((err: unknown) => (err as { code?: string }).code);
    expect(refusedNonPlain).toBe('PYRIC_LIVE_REFUSED');

    const duplex = hostClient.write();
    const duplexErr = await new Promise<unknown>((resolve) => {
      duplex.once('error', resolve);
      duplex.write(new CustomGapicRequest({ name: 'projects/org-beta/databases/(default)/documents/items/1' }));
    });
    expect((duplexErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');
  });
});
