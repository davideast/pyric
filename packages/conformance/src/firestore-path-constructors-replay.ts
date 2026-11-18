/**
 * Shared dual-plane replay drivers for all 7 `Path constructors` production
 * captures (`firestore#7, #8, #9, #10, #11, #12, #14`).
 *
 * Drives identical operations over `inPageContext()` (`pyric/firestore`) and
 * `servedFirestoreContext()` (served worker client + real host) and compares
 * every invariant verbatim against the committed `firebase/firestore` 12.19.0
 * observation JSON payloads.
 */
import type { Behavior } from './capture/sdk-scenarios/replay-comparison.ts';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';
import {
  isFirestoreAutoIdShape,
  observeFirestoreConstructorCall,
} from './firestore-path-constructor-probe-helpers.ts';

type ErrorConstructor = abstract new (...args: never[]) => Error;

function subcollectionPath(ctx: FirestoreScenarioContext, suffix: string): string {
  return `${ctx.base}/${suffix}`;
}

function summarizeConstructorError(raw: {
  threw: boolean;
  isFirebaseError: boolean;
  isTypeError: boolean;
  code: string | null;
}): Record<string, unknown> {
  return {
    threw: raw.threw,
    isFirebaseError: raw.isFirebaseError,
    isTypeError: raw.isTypeError,
    code: raw.code,
  };
}

function summarizeUnknownRefError(raw: {
  threw: boolean;
  errorName: string | null;
  isTypeError: boolean;
  isFirebaseError: boolean;
  code: string | null;
}): Record<string, unknown> {
  return {
    threw: raw.threw,
    errorName: raw.errorName,
    isTypeError: raw.isTypeError,
    isFirebaseError: raw.isFirebaseError,
    code: raw.code,
  };
}

export async function replayDocDbPathReferenceShape(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const simpleRef = fs.doc(db, 'items/item-1');
  const nestedRef = fs.doc(db, 'orgs/o1/members/m2');
  const slashTrimmedRef = fs.doc(db, '/items/item-1/');

  const oddSegmentError = observeFirestoreConstructorCall(
    () => fs.doc(db, 'items'),
    firebaseErrorCtor,
  );
  const emptyPathError = observeFirestoreConstructorCall(
    () => fs.doc(db, ''),
    firebaseErrorCtor,
  );

  const liveRef = fs.doc(db, `${subcollectionPath(ctx, 'pc-doc-db')}/d1`);
  await fs.setDoc(liveRef, { label: 'doc-db-roundtrip', n: 1 });
  const liveSnap = await fs.getDoc(liveRef);

  return {
    simple: {
      type: simpleRef.type,
      id: simpleRef.id,
      path: simpleRef.path,
      parentPath: simpleRef.parent.path,
      parentType: simpleRef.parent.type,
    },
    nested: {
      id: nestedRef.id,
      path: nestedRef.path,
      parentPath: nestedRef.parent.path,
    },
    slashTrimmedPath: slashTrimmedRef.path,
    slashTrimmedEqualsSimple: fs.refEqual(simpleRef, slashTrimmedRef),
    oddSegmentError: summarizeConstructorError(oddSegmentError),
    emptyPathError: summarizeConstructorError(emptyPathError),
    liveRoundtripData: liveSnap.data() ?? null,
  };
}

export async function replayDocVariadicSegments(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const fourSegRef = fs.doc(db, 'a', 'b', 'c', 'd');
  const mixedSegRef = fs.doc(db, 'a/b', 'c', 'd');
  const singleStringRef = fs.doc(db, 'a/b/c/d');

  const oddVariadicError = observeFirestoreConstructorCall(
    () => fs.doc(db, 'a', 'b', 'c'),
    firebaseErrorCtor,
  );

  const liveRef = fs.doc(db, ctx.base, 'pc-doc-variadic', 'd1');
  await fs.setDoc(liveRef, { joined: true, depth: 2 });
  const liveSnap = await fs.getDoc(fs.doc(db, `${ctx.base}/pc-doc-variadic/d1`));

  return {
    fourSeg: {
      type: fourSegRef.type,
      id: fourSegRef.id,
      path: fourSegRef.path,
      parentPath: fourSegRef.parent.path,
    },
    mixedSegPath: mixedSegRef.path,
    equalsSingleString: fs.refEqual(fourSegRef, singleStringRef),
    mixedEqualsSingleString: fs.refEqual(mixedSegRef, singleStringRef),
    oddVariadicError: summarizeConstructorError(oddVariadicError),
    liveRoundtripData: liveSnap.data() ?? null,
  };
}

export async function replayCollectionDbPathReferenceShape(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const rootColl = fs.collection(db, 'items');
  const nestedColl = fs.collection(db, 'orgs/o1/projects');
  const variadicColl = fs.collection(db, 'orgs', 'o1', 'projects');

  const evenSegmentError = observeFirestoreConstructorCall(
    () => fs.collection(db, 'orgs/o1'),
    firebaseErrorCtor,
  );

  const liveColl = fs.collection(db, subcollectionPath(ctx, 'pc-coll-db'));
  await fs.setDoc(fs.doc(liveColl, 'c1'), { kind: 'coll-db' });
  const querySnap = await fs.getDocs(liveColl);

  return {
    root: {
      type: rootColl.type,
      id: rootColl.id,
      path: rootColl.path,
      parentIsNull: rootColl.parent === null,
    },
    nested: {
      type: nestedColl.type,
      id: nestedColl.id,
      path: nestedColl.path,
      parentPath: nestedColl.parent?.path ?? null,
      parentType: nestedColl.parent?.type ?? null,
    },
    variadicEqualsNested: fs.refEqual(variadicColl, nestedColl),
    evenSegmentError: summarizeConstructorError(evenSegmentError),
    liveDocIds: querySnap.docs.map((entry) => entry.id),
  };
}

export async function replayDocFromCollectionWithId(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const items = fs.collection(db, 'items');
  const childDoc = fs.doc(items, 'item-42');
  const deepChildDoc = fs.doc(items, 'item-42', 'notes', 'note-1');

  const evenRelativeError = observeFirestoreConstructorCall(
    () => fs.doc(items, 'item-42', 'notes'),
    firebaseErrorCtor,
  );

  const liveColl = fs.collection(db, subcollectionPath(ctx, 'pc-doc-from-coll'));
  const liveChild = fs.doc(liveColl, 'row-10');
  await fs.setDoc(liveChild, { source: 'doc-from-collection' });
  const liveSnap = await fs.getDoc(fs.doc(db, `${liveColl.path}/row-10`));

  return {
    child: {
      type: childDoc.type,
      id: childDoc.id,
      path: childDoc.path,
      parentPath: childDoc.parent.path,
      equalsDbDoc: fs.refEqual(childDoc, fs.doc(db, 'items/item-42')),
    },
    deepChild: {
      id: deepChildDoc.id,
      path: deepChildDoc.path,
      parentPath: deepChildDoc.parent.path,
      equalsDbDoc: fs.refEqual(deepChildDoc, fs.doc(db, 'items/item-42/notes/note-1')),
    },
    evenRelativeError: summarizeConstructorError(evenRelativeError),
    liveRoundtripData: liveSnap.data() ?? null,
  };
}

export async function replayDocFromCollectionAutoid(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const items = fs.collection(db, 'items');
  const autoRefA = fs.doc(items);
  const autoRefB = fs.doc(items);
  const docDbNoPath = observeFirestoreConstructorCall(
    () => (fs.doc as unknown as (parent: unknown) => unknown)(db),
    firebaseErrorCtor,
  );

  const liveColl = fs.collection(db, subcollectionPath(ctx, 'pc-doc-autoid'));
  const liveAutoRef = fs.doc(liveColl);
  await fs.setDoc(liveAutoRef, { autoMinted: true });
  const liveSnap = await fs.getDoc(fs.doc(liveColl, liveAutoRef.id));

  return {
    type: autoRefA.type,
    idLength: autoRefA.id.length,
    idIsAlphanumeric20: isFirestoreAutoIdShape(autoRefA.id),
    secondIdIsAlphanumeric20: isFirestoreAutoIdShape(autoRefB.id),
    twoCallsDistinct: autoRefA.id !== autoRefB.id,
    pathMatchesCollectionAndId: autoRefA.path === `items/${autoRefA.id}`,
    parentPath: autoRefA.parent.path,
    docDbNoPathError: summarizeConstructorError(docDbNoPath),
    liveRoundtripData: liveSnap.data() ?? null,
  };
}

export async function replayCollectionFromDocSubcollection(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Behavior> {
  const { fs, db } = ctx;
  const parentDoc = fs.doc(db, 'users/u1');
  const subColl = fs.collection(parentDoc, 'tasks');
  const deepSubColl = fs.collection(parentDoc, 'tasks', 't1', 'comments');

  const evenRelativeError = observeFirestoreConstructorCall(
    () => fs.collection(parentDoc, 'tasks', 't1'),
    firebaseErrorCtor,
  );

  const liveParentDoc = fs.doc(fs.collection(db, subcollectionPath(ctx, 'pc-subcoll')), 'u1');
  const liveSubColl = fs.collection(liveParentDoc, 'tasks');
  await fs.setDoc(fs.doc(liveSubColl, 'task-1'), { done: true });
  const snap = await fs.getDocs(liveSubColl);

  let parentEqualsDocRef = false;
  if (subColl.parent !== null && subColl.parent !== undefined) {
    parentEqualsDocRef = fs.refEqual(subColl.parent, parentDoc);
  }

  return {
    sub: {
      type: subColl.type,
      id: subColl.id,
      path: subColl.path,
      parentPath: subColl.parent?.path ?? null,
      parentEqualsDocRef,
      equalsDbCollection: fs.refEqual(subColl, fs.collection(db, 'users/u1/tasks')),
    },
    deepSub: {
      id: deepSubColl.id,
      path: deepSubColl.path,
      parentPath: deepSubColl.parent?.path ?? null,
      equalsDbCollection: fs.refEqual(
        deepSubColl,
        fs.collection(db, 'users/u1/tasks/t1/comments'),
      ),
    },
    evenRelativeError: summarizeConstructorError(evenRelativeError),
    liveSubDocIds: snap.docs.map((entry) => entry.id),
  };
}

export function replayPathConstructorsUnknownRefErrors(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Behavior {
  const { fs } = ctx;
  const fakePlainObject = {};
  const fakeCollectionLookalike = { type: 'collection', id: 'items', path: 'items' };
  const fakeDocumentLookalike = { type: 'document', id: 'd1', path: 'items/d1' };

  const docPlainObject = observeFirestoreConstructorCall(
    () => fs.doc(fakePlainObject as never, 'items/d1'),
    firebaseErrorCtor,
  );
  const docFakeCollection = observeFirestoreConstructorCall(
    () => fs.doc(fakeCollectionLookalike as never, 'd1'),
    firebaseErrorCtor,
  );
  const collectionPlainObject = observeFirestoreConstructorCall(
    () => fs.collection(fakePlainObject as never, 'items'),
    firebaseErrorCtor,
  );
  const collectionFakeDoc = observeFirestoreConstructorCall(
    () => fs.collection(fakeDocumentLookalike as never, 'sub'),
    firebaseErrorCtor,
  );
  const collectionGroupPlainObject = observeFirestoreConstructorCall(
    () => fs.collectionGroup(fakePlainObject as never, 'items'),
    firebaseErrorCtor,
  );

  return {
    docPlainObject: summarizeUnknownRefError(docPlainObject),
    docFakeCollection: summarizeUnknownRefError(docFakeCollection),
    collectionPlainObject: summarizeUnknownRefError(collectionPlainObject),
    collectionFakeDoc: summarizeUnknownRefError(collectionFakeDoc),
    collectionGroupPlainObject: summarizeUnknownRefError(collectionGroupPlainObject),
  };
}

export async function verifyPathConstructorCrossTypeRefParity(
  ctx: FirestoreScenarioContext,
  firebaseErrorCtor: ErrorConstructor,
): Promise<Record<string, unknown>> {
  const { fs, db } = ctx;
  const converter = {
    toFirestore(value: { title: string }) {
      return { storedTitle: value.title };
    },
    fromFirestore(snap: { data: () => Record<string, unknown> }) {
      const rawTitle = snap.data().storedTitle ?? '';
      return { title: String(rawTitle) };
    },
  };

  const typedDocRef = fs.doc(db, 'users/u1').withConverter(converter as never);
  const typedCollRef = fs.collection(db, 'users').withConverter(converter as never);
  const constrainedQuery = fs.query(typedCollRef, fs.where('storedTitle', '==', 'x'));
  const groupQuery = fs.collectionGroup(db, 'posts');

  const docFromDocRef = fs.doc(typedDocRef, 'posts', 'p1');
  const collFromCollRef = fs.collection(typedCollRef, 'u1', 'posts');

  const liveParentDoc = fs.doc(db, `${subcollectionPath(ctx, 'pc-doc-from-doc')}/u1`);
  const liveNestedDoc = fs.doc(liveParentDoc, 'posts', 'p1');
  await fs.setDoc(liveNestedDoc, { viaDocParent: true });
  const liveNestedSnap = await fs.getDoc(fs.doc(db, `${liveParentDoc.path}/posts/p1`));

  const invalidCalls = {
    docFromDocZeroArg: summarizeConstructorError(
      observeFirestoreConstructorCall(
        () => (fs.doc as unknown as (p: unknown) => unknown)(typedDocRef),
        firebaseErrorCtor,
      ),
    ),
    docFromDocOddSegs: summarizeConstructorError(
      observeFirestoreConstructorCall(() => fs.doc(typedDocRef, 'posts'), firebaseErrorCtor),
    ),
    collFromCollZeroArg: summarizeConstructorError(
      observeFirestoreConstructorCall(
        () => (fs.collection as unknown as (p: unknown) => unknown)(typedCollRef),
        firebaseErrorCtor,
      ),
    ),
    collFromCollEvenSegs: summarizeConstructorError(
      observeFirestoreConstructorCall(() => fs.collection(typedCollRef, 'u1'), firebaseErrorCtor),
    ),
    docFromQuery: summarizeConstructorError(
      observeFirestoreConstructorCall(() => fs.doc(constrainedQuery as never, 'p1'), firebaseErrorCtor),
    ),
    docFromGroupQuery: summarizeConstructorError(
      observeFirestoreConstructorCall(() => fs.doc(groupQuery as never, 'p1'), firebaseErrorCtor),
    ),
    collFromQuery: summarizeConstructorError(
      observeFirestoreConstructorCall(
        () => fs.collection(constrainedQuery as never, 'sub'),
        firebaseErrorCtor,
      ),
    ),
    groupFromDocRef: summarizeConstructorError(
      observeFirestoreConstructorCall(
        () => fs.collectionGroup(typedDocRef as never, 'posts'),
        firebaseErrorCtor,
      ),
    ),
    groupFromCollRef: summarizeConstructorError(
      observeFirestoreConstructorCall(
        () => fs.collectionGroup(typedCollRef as never, 'posts'),
        firebaseErrorCtor,
      ),
    ),
    groupFromQuery: summarizeConstructorError(
      observeFirestoreConstructorCall(
        () => fs.collectionGroup(constrainedQuery as never, 'posts'),
        firebaseErrorCtor,
      ),
    ),
  };

  return {
    docFromDocPath: docFromDocRef.path,
    docFromDocConverterIsNull: docFromDocRef.converter === null,
    docFromDocEqualsDirect: fs.refEqual(docFromDocRef, fs.doc(db, 'users/u1/posts/p1')),
    collFromCollPath: collFromCollRef.path,
    collFromCollConverterIsNull: collFromCollRef.converter === null,
    collFromCollParentPath: collFromCollRef.parent?.path ?? null,
    collFromCollEqualsDirect: fs.refEqual(collFromCollRef, fs.collection(db, 'users/u1/posts')),
    liveNestedRoundtrip: liveNestedSnap.data() ?? null,
    invalidCalls,
  };
}
