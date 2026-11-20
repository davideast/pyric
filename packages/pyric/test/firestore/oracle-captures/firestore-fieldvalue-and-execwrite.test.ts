import { describe, expect, it } from 'bun:test';
import { FirebaseError } from '../../../src/app/index.js';
import { initializeSandbox, type Sandbox } from '../../../src/sandbox/index.js';
import * as pyricFirestore from '../../../src/firestore/index.js';
import {
  observeFirestoreEnsureConfiguredAndExecuteWrite,
  type EnsureConfiguredAndExecuteWriteSubject,
} from '../../../../conformance/probes/firestore/firestore-ensure-configured-and-execute-write.ts';
import {
  observeFirestoreFieldValueClassAndEquality,
} from '../../../../conformance/probes/firestore/firestore-field-value-class-and-equality.ts';
import { load } from './support.ts';

describe('in-page oracle replay: FieldValue inheritance/equality and ensureFirestoreConfigured/executeWrite', () => {
  it('replays firestore-field-value-class-and-equality against pyric/firestore (firestore#105)', () => {
    const observed = load('firestore-field-value-class-and-equality');
    const actual = observeFirestoreFieldValueClassAndEquality({
      FieldValue: pyricFirestore.FieldValue,
      deleteField: () => pyricFirestore.deleteField(),
      serverTimestamp: () => pyricFirestore.serverTimestamp(),
      increment: (n: number) => pyricFirestore.increment(n),
      arrayUnion: (...elements: unknown[]) => pyricFirestore.arrayUnion(...elements),
      arrayRemove: (...elements: unknown[]) => pyricFirestore.arrayRemove(...elements),
      vector: (values?: number[]) => pyricFirestore.vector(values),
    });

    expect(actual).toEqual(observed);
  });

  it('replays firestore-ensure-configured-and-execute-write against pyric/firestore (firestore#156)', async () => {
    const observed = load('firestore-ensure-configured-and-execute-write');
    const subject: EnsureConfiguredAndExecuteWriteSubject<
      Sandbox,
      ReturnType<typeof pyricFirestore.getFirestore>
    > = {
      createApp() {
        return initializeSandbox();
      },
      async deleteApp(sandbox) {
        sandbox.dispose();
      },
      getFirestore(sandbox) {
        return pyricFirestore.getFirestore(sandbox);
      },
      ensureFirestoreConfigured(db) {
        return pyricFirestore.ensureFirestoreConfigured(db);
      },
      executeWrite(db, mutations: unknown[]) {
        return pyricFirestore.executeWrite(db, mutations);
      },
      connectEmulator(db, host: string, port: number) {
        pyricFirestore.connectFirestoreEmulator(db, host, port);
      },
      terminate(db) {
        return pyricFirestore.terminate(db);
      },
      isFirebaseError(err: unknown): boolean {
        return err instanceof FirebaseError;
      },
    };

    const actual = await observeFirestoreEnsureConfiguredAndExecuteWrite(subject);
    expect(actual).toEqual(observed);
  });
});
