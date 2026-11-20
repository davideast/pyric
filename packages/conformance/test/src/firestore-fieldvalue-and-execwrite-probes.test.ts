import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'firebase/app';
import * as fsMod from 'firebase/firestore';
import {
  observeFirestoreEnsureConfiguredAndExecuteWrite,
  probe as ensureConfiguredProbe,
} from '../../probes/firestore/firestore-ensure-configured-and-execute-write.ts';
import {
  observeFirestoreFieldValueClassAndEquality,
  probe as fieldValueProbe,
} from '../../probes/firestore/firestore-field-value-class-and-equality.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

describe('Firestore FieldValue and ensureFirestoreConfigured/executeWrite staged probes', () => {
  it('registers both sdk-probes targets with expectStagedUntilCaptured', () => {
    expect(fieldValueProbe.rig).toBe('sdk-probes');
    expect(fieldValueProbe.requires).toEqual([]);
    expect(ensureConfiguredProbe.rig).toBe('sdk-probes');
    expect(ensureConfiguredProbe.requires).toEqual(['web-config']);

    expectStagedUntilCaptured(
      [
        'firestore-field-value-class-and-equality',
        'firestore-ensure-configured-and-execute-write',
      ],
      {
        rig: 'sdk-probes',
        filterFlag: '--probe',
      },
    );
  });

  it('observes real firebase/firestore FieldValue inheritance and sentinel isEqual offline', () => {
    const observed = observeFirestoreFieldValueClassAndEquality({
      FieldValue: fsMod.FieldValue,
      deleteField: () => fsMod.deleteField(),
      serverTimestamp: () => fsMod.serverTimestamp(),
      increment: (n: number) => fsMod.increment(n),
      arrayUnion: (...elements: unknown[]) => fsMod.arrayUnion(...elements),
      arrayRemove: (...elements: unknown[]) => fsMod.arrayRemove(...elements),
      vector: (values?: number[]) => fsMod.vector(values),
    });

    expect(observed).toEqual({
      isFieldValueExportFunction: true,
      instanceOfChecks: {
        deleteField: true,
        serverTimestamp: true,
        increment: true,
        arrayUnion: true,
        arrayRemove: true,
        vector: false,
      },
      hasIsEqualMethod: {
        deleteField: true,
        serverTimestamp: true,
        increment: true,
        arrayUnion: true,
        arrayRemove: true,
      },
      equalityChecks: {
        deleteFieldSelf: true,
        deleteFieldVsServerTimestamp: false,
        serverTimestampSelf: true,
        serverTimestampVsIncrement: false,
        incrementSameFinite: true,
        incrementDifferentFinite: false,
        incrementNaNSelf: true,
        incrementZeroAndNegZero: true,
        arrayUnionSameOrderAndTypes: true,
        arrayUnionDifferentOrder: false,
        arrayUnionNestedMapSame: true,
        arrayUnionVsArrayRemoveSameArgs: false,
        arrayRemoveSameArgs: true,
        arrayRemoveDifferentArgs: false,
      },
    });
  });

  it('records synchronous post-start and post-terminate outcomes in ensureFirestoreConfigured/executeWrite observer', async () => {
    interface MockDb {
      started: boolean;
      terminated: boolean;
    }

    const observed = await observeFirestoreEnsureConfiguredAndExecuteWrite<string, MockDb>({
      createApp: (name) => name,
      deleteApp: async () => undefined,
      getFirestore: () => ({ started: false, terminated: false }),
      ensureFirestoreConfigured(db) {
        if (db.terminated) {
          throw new FirebaseError('failed-precondition', 'The client has already been terminated.');
        }
        db.started = true;
        return { client: true };
      },
      executeWrite(db, _mutations) {
        if (db.terminated) {
          throw new FirebaseError('failed-precondition', 'The client has already been terminated.');
        }
        db.started = true;
        return Promise.resolve();
      },
      connectEmulator(db) {
        if (db.started) {
          throw new FirebaseError('failed-precondition', 'Firestore has already been started.');
        }
      },
      terminate: async (db) => {
        db.terminated = true;
      },
      isFirebaseError: (err) => err instanceof FirebaseError,
    });

    expect(observed).toEqual({
      configuredReturn: { isObject: true },
      emulatorAfterEnsureConfigured: {
        syncThrew: true,
        rejected: false,
        code: 'failed-precondition',
        isFirebaseError: true,
      },
      emptyExecuteWriteOnActiveDb: { resolvedUndefined: true },
      emulatorAfterEmptyExecuteWrite: {
        syncThrew: true,
        rejected: false,
        code: 'failed-precondition',
        isFirebaseError: true,
      },
      ensureConfiguredAfterTerminate: {
        syncThrew: true,
        rejected: false,
        code: 'failed-precondition',
        isFirebaseError: true,
      },
      executeWriteAfterTerminate: {
        syncThrew: true,
        rejected: false,
        code: 'failed-precondition',
        isFirebaseError: true,
      },
    });
  });
});
