import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import * as pyricAdminFirestore from 'pyric-admin/firestore';
import { attachSnapshotFactoryToFirestore } from '../../src/functions/firestore/snapshot-bridge.js';
import { encodeFirestoreDocumentEventData } from '../../src/functions/firestore/proto-encoder.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const protos = requireFromConformance(
  './node_modules/firebase-functions/protos/compiledFirestore.js',
) as {
  google: {
    events: {
      cloud: {
        firestore: {
          v1: {
            DocumentEventData: {
              decode(buf: Uint8Array): { value?: unknown; oldValue?: unknown };
            };
          };
        };
      };
    };
  };
};

describe('attachSnapshotFactoryToFirestore', () => {
  test('materializes existing and non-existent snapshots with working readTime, FieldPath.get, and ref.update write-back', async () => {
    const sandbox = initializeSandbox();
    const db = pyricAdminFirestore.getAdminFirestore(sandbox);
    const dbWithSnap = db as unknown as {
      doc: (path: string) => { get(): Promise<{ data(): Record<string, unknown> | undefined }> };
      snapshot_?: (docOrName: unknown, readTime: unknown, encoding?: string) => {
        exists: boolean;
        id: string;
        ref: { path: string; update(data: Record<string, unknown>): Promise<unknown> };
        createTime: { seconds: number; nanoseconds: number } | undefined;
        updateTime: { seconds: number; nanoseconds: number } | undefined;
        readTime: { seconds: number; nanoseconds: number };
        data(): Record<string, unknown> | undefined;
        get(field: string | InstanceType<typeof pyricAdminFirestore.FieldPath>): unknown;
        isEqual(other: unknown): boolean;
      };
    };

    attachSnapshotFactoryToFirestore(dbWithSnap, pyricAdminFirestore);
    if (dbWithSnap.snapshot_ === undefined) {
      throw new Error('expected snapshot_ factory to be attached');
    }

    await db.doc('users/alice').set({ name: 'Alice', 'literal.dot': 'dotted-ok' });

    const encoded = encodeFirestoreDocumentEventData(
      {
        value: {
          name: 'projects/demo-project/databases/(default)/documents/users/alice',
          fields: {
            name: 'Alice',
            'literal.dot': 'dotted-ok',
            nested: { score: 99 },
            when: new pyricAdminFirestore.Timestamp(1_700_000_100, 500),
            where: new pyricAdminFirestore.GeoPoint(51.5074, -0.1278),
            raw: Buffer.from([10, 20, 30]),
          },
          createTime: { seconds: 1_700_000_100, nanos: 0 },
          updateTime: { seconds: 1_700_000_105, nanos: 250 },
        },
      },
      { projectId: 'demo-project', database: '(default)' },
    );
    const decoded = protos.google.events.cloud.firestore.v1.DocumentEventData.decode(encoded);

    const existingSnap = dbWithSnap.snapshot_(decoded.value, null, 'protobufJS');
    const duplicateSnap = dbWithSnap.snapshot_(decoded.value, null, 'protobufJS');
    expect(existingSnap.exists).toBe(true);
    expect(existingSnap.id).toBe('alice');
    expect(existingSnap.ref.path).toBe('users/alice');
    expect(existingSnap.createTime?.seconds).toBe(1_700_000_100);
    expect(existingSnap.updateTime?.seconds).toBe(1_700_000_105);
    expect(existingSnap.updateTime?.nanoseconds).toBe(250);
    expect(existingSnap.readTime.seconds).toBe(1_700_000_105);
    expect(existingSnap.get('nested.score')).toBe(99);
    expect(existingSnap.get(new pyricAdminFirestore.FieldPath('literal.dot'))).toBe('dotted-ok');
    expect(existingSnap.isEqual(duplicateSnap)).toBe(true);

    const data = existingSnap.data();
    expect(data?.when).toBeInstanceOf(pyricAdminFirestore.Timestamp);
    expect(data?.where).toBeInstanceOf(pyricAdminFirestore.GeoPoint);
    expect(Buffer.isBuffer(data?.raw)).toBe(true);

    await existingSnap.ref.update({ stampedByTrigger: true });
    const updatedDoc = await db.doc('users/alice').get();
    expect(updatedDoc.data()).toEqual({
      name: 'Alice',
      'literal.dot': 'dotted-ok',
      stampedByTrigger: true,
    });

    const missingSnap = dbWithSnap.snapshot_(
      'projects/demo-project/databases/(default)/documents/users/ghost',
      { seconds: 1_700_000_200, nanos: 0 },
      'protobufJS',
    );
    expect(missingSnap.exists).toBe(false);
    expect(missingSnap.id).toBe('ghost');
    expect(missingSnap.createTime).toBeUndefined();
    expect(missingSnap.updateTime).toBeUndefined();
    expect(missingSnap.readTime.seconds).toBe(1_700_000_200);
    expect(missingSnap.data()).toBeUndefined();
    expect(missingSnap.get('nested.score')).toBeUndefined();
    expect(existingSnap.isEqual(missingSnap)).toBe(false);
    sandbox.dispose();
  });
});
