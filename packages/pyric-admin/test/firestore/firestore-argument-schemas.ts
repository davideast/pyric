/**
 * Local (`Sandbox`) and JSON-wire remote (`RemoteSandbox`) arm adapters for
 * `pyric-admin/firestore` generative argument differential testing.
 */

import { deleteApp, type PyricAdminApp } from 'pyric-admin/app';
import {
  FieldPath,
  FieldValue,
  Timestamp,
  getFirestore,
  type SandboxFirestore,
} from 'pyric-admin/firestore';

import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';
import type { FirestoreDialectRuntime } from './firestore-combinators.js';
import type { OfflineUpstreamFirestoreHarness } from './upstream-firestore-oracle.js';

export interface FirestoreSandboxArm {
  readonly kind: 'local' | 'remote';
  readonly app: PyricAdminApp;
  readonly db: SandboxFirestore;
  readonly runtime: FirestoreDialectRuntime;
  readonly ensureSeeded: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export async function createPyricFirestoreArm(
  kind: 'local' | 'remote',
): Promise<FirestoreSandboxArm> {
  let pair: ReturnType<typeof inProcessFirestoreArm>;
  if (kind === 'local') {
    pair = inProcessFirestoreArm();
  } else {
    pair = sharedWorkerFirestoreArm();
  }
  const db = getFirestore(pair.app);
  const existingDocPath = 'items/existing';
  let createSeq = 0;

  const ensureSeeded = async (): Promise<void> => {
    await db.doc(existingDocPath).set({
      title: 'Seeded',
      count: 1,
      nested: { flag: true },
    });
  };
  await ensureSeeded();

  const runtime: FirestoreDialectRuntime = {
    db: db as unknown as FirestoreDialectRuntime['db'],
    FieldPath: FieldPath as unknown as FirestoreDialectRuntime['FieldPath'],
    documentId: () => FieldPath.documentId(),
    FieldValue: FieldValue as unknown as FirestoreDialectRuntime['FieldValue'],
    Timestamp: Timestamp as unknown as FirestoreDialectRuntime['Timestamp'],
    existingDocPath,
    nextAbsentDocPath: () => `items/fresh-${++createSeq}`,
  };

  return {
    kind,
    app: pair.app,
    db,
    runtime,
    ensureSeeded,
    dispose: async () => {
      await deleteApp(pair.app).catch(() => {});
      pair.host.dispose();
    },
  };
}

export function toUpstreamDialectRuntime(
  upstream: OfflineUpstreamFirestoreHarness,
): FirestoreDialectRuntime {
  return {
    db: upstream.db as unknown as FirestoreDialectRuntime['db'],
    FieldPath: upstream.FieldPath as unknown as FirestoreDialectRuntime['FieldPath'],
    documentId: () => upstream.FieldPath.documentId(),
    FieldValue: upstream.FieldValue as unknown as FirestoreDialectRuntime['FieldValue'],
    Timestamp: upstream.Timestamp as unknown as FirestoreDialectRuntime['Timestamp'],
    existingDocPath: upstream.existingDocPath,
    nextAbsentDocPath: upstream.nextAbsentDocPath,
  };
}
