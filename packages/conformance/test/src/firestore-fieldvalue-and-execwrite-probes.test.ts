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
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

describe('Firestore FieldValue and ensureFirestoreConfigured/executeWrite staged probes', () => {
  it('registers both sdk-probes targets with expectStagedUntilCaptured', () => {
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
    expect(ensureConfiguredProbe.rig).toBe('sdk-probes');
    expect(ensureConfiguredProbe.requires).toEqual([]);

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
