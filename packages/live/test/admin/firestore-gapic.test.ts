import { describe, expect, it } from 'bun:test';
import { Duplex, Readable } from 'node:stream';
import type { LiveCallRecord, LiveObserver } from '../../src/observe.js';
import {
  assertGapicPayloadAllowed,
  patchFirestoreGapicClients,
} from '../../src/admin/firestore-gapic.js';
import { isAdminMethodGated, runInsideAdminCall } from '../../src/admin/patch.js';
import { adminProjectGate, failClosedGate } from '../../src/admin/project-gate.js';

const HOST_PROJECT = 'org-alpha';

describe('firestore-gapic', () => {
  const observer: LiveObserver = Object.assign(
    (_record: LiveCallRecord) => undefined,
    { client: 'node' as const, hostProjectId: HOST_PROJECT },
  );

  it('validates GAPIC resource strings across cross-project and named-database payloads', () => {
    expect(() =>
      assertGapicPayloadAllowed(
        [{ parent: `projects/${HOST_PROJECT}/databases/(default)/documents` }],
        observer,
      ),
    ).not.toThrow();

    let crossProjErr: unknown;
    try {
      assertGapicPayloadAllowed(
        [{ name: 'projects/org-beta/databases/(default)/documents/items/1' }],
        observer,
      );
    } catch (err) {
      crossProjErr = err;
    }
    expect((crossProjErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    let namedDbErr: unknown;
    try {
      assertGapicPayloadAllowed(
        [{ writes: [{ update: { name: `projects/${HOST_PROJECT}/databases/analytics-db/documents/items/1` } }] }],
        observer,
      );
    } catch (err) {
      namedDbErr = err;
    }
    expect((namedDbErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');

    let createDbErr: unknown;
    try {
      assertGapicPayloadAllowed(
        [{ parent: `projects/${HOST_PROJECT}`, databaseId: 'secondary-db' }],
        observer,
      );
    } catch (err) {
      createDbErr = err;
    }
    expect((createDbErr as { code?: string })?.code).toBe('PYRIC_LIVE_REFUSED');
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
  });
});
