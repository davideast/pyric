import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import {
  replayCollectionDbPathReferenceShape,
  replayCollectionFromDocSubcollection,
  replayDocDbPathReferenceShape,
  replayDocFromCollectionAutoid,
  replayDocFromCollectionWithId,
  replayDocVariadicSegments,
  replayPathConstructorsUnknownRefErrors,
  verifyPathConstructorCrossTypeRefParity,
} from '../../../../../conformance/src/firestore-path-constructors-replay.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

describe('Firestore Path constructors oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('firestore-doc-db-path-reference-shape (firestore#7)', async () => {
    const production = load('firestore-doc-db-path-reference-shape');
    const pyric = await replayDocDbPathReferenceShape(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('firestore-doc-variadic-segments (firestore#8)', async () => {
    const production = load('firestore-doc-variadic-segments');
    const pyric = await replayDocVariadicSegments(await servedFirestoreContext(), FirebaseError);
    expectReplay({ production, pyric });
  });

  it('firestore-collection-db-path-reference-shape (firestore#9)', async () => {
    const production = load('firestore-collection-db-path-reference-shape');
    const pyric = await replayCollectionDbPathReferenceShape(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('firestore-doc-from-collection-with-id (firestore#10)', async () => {
    const production = load('firestore-doc-from-collection-with-id');
    const pyric = await replayDocFromCollectionWithId(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('firestore-doc-from-collection-autoid (firestore#11)', async () => {
    const production = load('firestore-doc-from-collection-autoid');
    const pyric = await replayDocFromCollectionAutoid(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('firestore-collection-from-doc-subcollection (firestore#12)', async () => {
    const production = load('firestore-collection-from-doc-subcollection');
    const pyric = await replayCollectionFromDocSubcollection(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('firestore-path-constructors-unknown-ref-errors (firestore#14)', async () => {
    const production = load('firestore-path-constructors-unknown-ref-errors');
    const pyric = replayPathConstructorsUnknownRefErrors(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expectReplay({ production, pyric });
  });

  it('supports doc(docRef, ...) and collection(collRef, ...) with converter: null while rejecting Query parents', async () => {
    const expectedInvalid = {
      threw: true,
      isFirebaseError: true,
      isTypeError: false,
      code: 'invalid-argument',
    };
    const actual = await verifyPathConstructorCrossTypeRefParity(
      await servedFirestoreContext(),
      FirebaseError,
    );
    expect(actual).toEqual({
      docFromDocPath: 'users/u1/posts/p1',
      docFromDocConverterIsNull: true,
      docFromDocEqualsDirect: true,
      collFromCollPath: 'users/u1/posts',
      collFromCollConverterIsNull: true,
      collFromCollParentPath: 'users/u1',
      collFromCollEqualsDirect: true,
      liveNestedRoundtrip: { viaDocParent: true },
      invalidCalls: {
        docFromDocZeroArg: expectedInvalid,
        docFromDocOddSegs: expectedInvalid,
        collFromCollZeroArg: expectedInvalid,
        collFromCollEvenSegs: expectedInvalid,
        docFromQuery: expectedInvalid,
        docFromGroupQuery: expectedInvalid,
        collFromQuery: expectedInvalid,
        groupFromDocRef: expectedInvalid,
        groupFromCollRef: expectedInvalid,
        groupFromQuery: expectedInvalid,
      },
    });
  });
});
