import { describe, expect, it } from 'bun:test';
import * as fsMod from 'firebase/firestore';
import {
  observeFirestoreEnsureConfiguredAndExecuteWrite,
  probe as ensureConfiguredProbe,
  type EnsureConfiguredAndExecuteWriteSubject,
} from '../../probes/firestore/firestore-ensure-configured-and-execute-write.ts';
import {
  observeFirestoreFieldValueClassAndEquality,
  probe as fieldValueProbe,
  type FieldValueClassAndEqualitySubject,
} from '../../probes/firestore/firestore-field-value-class-and-equality.ts';

describe('Firestore FieldValue and ensureFirestoreConfigured/executeWrite linked probes', () => {
  it('links both sdk-probes targets to firestore#105 and firestore#156', () => {
    const verifyExports: readonly [
      typeof observeFirestoreFieldValueClassAndEquality,
      typeof observeFirestoreEnsureConfiguredAndExecuteWrite,
      FieldValueClassAndEqualitySubject | null,
      EnsureConfiguredAndExecuteWriteSubject<unknown, unknown> | null,
    ] = [
      observeFirestoreFieldValueClassAndEquality,
      observeFirestoreEnsureConfiguredAndExecuteWrite,
      null,
      null,
    ];
    expect(typeof verifyExports[0]).toBe('function');
    expect(typeof verifyExports[1]).toBe('function');
    expect(fieldValueProbe.rig).toBe('sdk-probes');
    expect(fieldValueProbe.requires).toEqual([]);
    expect(fieldValueProbe.matrixRow).toBe('firestore#105');
    expect(fieldValueProbe.rowIds).toEqual(['firestore#105']);
    expect(fieldValueProbe.pendingRowLink).toBeUndefined();
    expect(ensureConfiguredProbe.rig).toBe('sdk-probes');
    expect(ensureConfiguredProbe.requires).toEqual([]);
    expect(ensureConfiguredProbe.matrixRow).toBe('firestore#156');
    expect(ensureConfiguredProbe.rowIds).toEqual(['firestore#156']);
    expect(ensureConfiguredProbe.pendingRowLink).toBeUndefined();
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

  it('observes real firebase/firestore ensureFirestoreConfigured and executeWrite offline', async () => {
    const observed = await ensureConfiguredProbe.observe();

    expect(observed).toEqual({
      configuredReturn: {
        isObject: true,
        sameClientOnRepeat: true,
      },
      emulatorAfterEnsureConfigured: {
        syncThrew: true,
        rejected: false,
        code: 'failed-precondition',
        isFirebaseError: true,
      },
      executeWriteOnActiveDb: {
        syncThrew: false,
        returnsPromise: true,
      },
      emulatorAfterExecuteWrite: {
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
