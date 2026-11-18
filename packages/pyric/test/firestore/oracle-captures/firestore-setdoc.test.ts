import { describe, expect, it } from 'bun:test';
import { FirebaseError } from '../../../src/app/index.js';
import {
  replaySetDocBothMergeAndMergeFields,
  replaySetDocConverterOptionsForwarding,
  replaySetDocDefaultReplacesEntireDoc,
  replaySetDocMergeFieldsDottedAndFieldPath,
  replaySetDocMergeTrueDeepMergesMaps,
  verifySetDocAtomicMergePrecedence,
} from '../../../../conformance/src/firestore-setdoc-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore setDoc oracle captures (in-page pyric/firestore)', () => {
  it('firestore-setdoc-default-replaces-entire-doc (firestore#26)', async () => {
    const production = load('firestore-setdoc-default-replaces-entire-doc');
    const pyric = await replaySetDocDefaultReplacesEntireDoc(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-merge-true-deep-merges-maps (firestore#27)', async () => {
    const production = load('firestore-setdoc-merge-true-deep-merges-maps');
    const pyric = await replaySetDocMergeTrueDeepMergesMaps(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-mergefields-dotted-and-fieldpath (firestore#28)', async () => {
    const production = load('firestore-setdoc-mergefields-dotted-and-fieldpath');
    const pyric = await replaySetDocMergeFieldsDottedAndFieldPath(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-both-merge-and-mergefields (firestore#29)', async () => {
    const production = load('firestore-setdoc-both-merge-and-mergefields');
    const pyric = await replaySetDocBothMergeAndMergeFields(inPageContext(), FirebaseError);
    expectReplay({ production, pyric });
  });

  it('firestore-setdoc-converter-options-forwarding (firestore#31)', async () => {
    const production = load('firestore-setdoc-converter-options-forwarding');
    const pyric = await replaySetDocConverterOptionsForwarding(inPageContext());
    expectReplay({ production, pyric });
  });

  it('honors merge: true precedence over mergeFields across setDoc, writeBatch.set, and runTransaction tx.set', async () => {
    const actual = await verifySetDocAtomicMergePrecedence(inPageContext());
    expect(actual).toEqual({
      setDocShortCircuit: { keep: 'kept', masked: 'new', extra: 'included' },
      batchMergeTrue: { existing: 'stay', masked: 'new-masked', unmasked: 'new-unmasked' },
      batchMergeFalse: { existing: 'stay', masked: 'new-masked', unmasked: 'old-unmasked' },
      txMergeTrue: { existing: 'stay', masked: 'new-masked', unmasked: 'new-unmasked' },
      txMergeFalse: { existing: 'stay', masked: 'new-masked', unmasked: 'old-unmasked' },
    });
  });
});
