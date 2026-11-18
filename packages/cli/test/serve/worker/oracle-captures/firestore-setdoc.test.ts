import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  replaySetDocBothMergeAndMergeFields,
  replaySetDocConverterOptionsForwarding,
  replaySetDocDefaultReplacesEntireDoc,
  replaySetDocMergeFieldsDottedAndFieldPath,
  replaySetDocMergeTrueDeepMergesMaps,
  verifySetDocAtomicMergePrecedence,
} from '../../../../../conformance/src/firestore-setdoc-replay.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

describe('Firestore setDoc oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('firestore-setdoc-default-replaces-entire-doc (firestore#26)', async () => {
    const production = load('firestore-setdoc-default-replaces-entire-doc');
    const pyric = await replaySetDocDefaultReplacesEntireDoc(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-merge-true-deep-merges-maps (firestore#27)', async () => {
    const production = load('firestore-setdoc-merge-true-deep-merges-maps');
    const pyric = await replaySetDocMergeTrueDeepMergesMaps(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-mergefields-dotted-and-fieldpath (firestore#28)', async () => {
    const production = load('firestore-setdoc-mergefields-dotted-and-fieldpath');
    const pyric = await replaySetDocMergeFieldsDottedAndFieldPath(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-both-merge-and-mergefields (firestore#29)', async () => {
    const production = load('firestore-setdoc-both-merge-and-mergefields');
    const pyric = await replaySetDocBothMergeAndMergeFields(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-converter-options-forwarding (firestore#31)', async () => {
    const production = load('firestore-setdoc-converter-options-forwarding');
    const pyric = await replaySetDocConverterOptionsForwarding(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('honors merge: true precedence over mergeFields across setDoc, writeBatch.set, and runTransaction tx.set', async () => {
    const actual = await verifySetDocAtomicMergePrecedence(await servedFirestoreContext());
    expect(actual).toEqual({
      setDocShortCircuit: { keep: 'kept', masked: 'new', extra: 'included' },
      batchMergeTrue: { existing: 'stay', masked: 'new-masked', unmasked: 'new-unmasked' },
      batchMergeFalse: { existing: 'stay', masked: 'new-masked', unmasked: 'old-unmasked' },
      txMergeTrue: { existing: 'stay', masked: 'new-masked', unmasked: 'new-unmasked' },
      txMergeFalse: { existing: 'stay', masked: 'new-masked', unmasked: 'old-unmasked' },
    });
  });
});
