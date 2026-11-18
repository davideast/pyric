import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreConstructorCall } from '../../src/firestore-path-constructor-probe-helpers.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

function summarizeUnknownRefOutcome(raw: {
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

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'doc, collection, and collectionGroup reject unrecognized or foreign first-argument objects with a deterministic error class and code.',
  async observe() {
    return withFirestoreProbeSession(async ({ firestoreSdk }) => {
      const { collection, collectionGroup, doc } = firestoreSdk;

      const fakePlainObject = {};
      const fakeCollectionLookalike = { type: 'collection', id: 'items', path: 'items' };
      const fakeDocumentLookalike = { type: 'document', id: 'd1', path: 'items/d1' };

      const docPlainObject = observeFirestoreConstructorCall(
        () => doc(fakePlainObject as never, 'items/d1'),
        FirebaseError,
      );
      const docFakeCollection = observeFirestoreConstructorCall(
        () => doc(fakeCollectionLookalike as never, 'd1'),
        FirebaseError,
      );
      const collectionPlainObject = observeFirestoreConstructorCall(
        () => collection(fakePlainObject as never, 'items'),
        FirebaseError,
      );
      const collectionFakeDoc = observeFirestoreConstructorCall(
        () => collection(fakeDocumentLookalike as never, 'sub'),
        FirebaseError,
      );
      const collectionGroupPlainObject = observeFirestoreConstructorCall(
        () => collectionGroup(fakePlainObject as never, 'items'),
        FirebaseError,
      );

      return {
        docPlainObject: summarizeUnknownRefOutcome(docPlainObject),
        docFakeCollection: summarizeUnknownRefOutcome(docFakeCollection),
        collectionPlainObject: summarizeUnknownRefOutcome(collectionPlainObject),
        collectionFakeDoc: summarizeUnknownRefOutcome(collectionFakeDoc),
        collectionGroupPlainObject: summarizeUnknownRefOutcome(collectionGroupPlainObject),
      };
    });
  },
};
