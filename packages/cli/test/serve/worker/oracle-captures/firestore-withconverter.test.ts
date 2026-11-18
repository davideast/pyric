import { describe, it } from 'bun:test';
import {
  replayWithConverterCollectionMethodPropagation,
  replayWithConverterCollectionPropagatesToDoc,
  replayWithConverterCollectionPropagatesToQueryGetDocs,
  replayWithConverterDocRoundtrip,
  replayWithConverterGetDocInvokesFromFirestore,
  replayWithConverterNullStripsConverter,
  replayWithConverterPreservesUntypedRefIdentity,
  replayWithConverterQueryMethodAndSubcollectionIsolation,
  replayWithConverterSetDocInvokesToFirestore,
  replayWithConverterUpdateDocBypassesConverter,
} from '../../../../../conformance/src/firestore-withconverter-replay.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

const WORKER_UNSUPPORTED_QUERY_EQUAL_REASON =
  'queryEqual is an explicitly unsupported served API (entries/unsupported/firestore.ts)';

describe('Firestore withConverter oracle captures (served worker client + host)', () => {
  restoreSharedWorker();

  it('firestore-withconverter-doc-roundtrip (firestore#46)', async () => {
    const production = load('firestore-withconverter-doc-roundtrip');
    const pyric = await replayWithConverterDocRoundtrip(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-collection-propagates-to-doc (firestore#47)', async () => {
    const production = load('firestore-withconverter-collection-propagates-to-doc');
    const pyric = await replayWithConverterCollectionPropagatesToDoc(
      await servedFirestoreContext(),
    );
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-collection-propagates-to-query-getdocs (firestore#48)', async () => {
    const production = load('firestore-withconverter-collection-propagates-to-query-getdocs');
    const pyric = await replayWithConverterCollectionPropagatesToQueryGetDocs(
      await servedFirestoreContext(),
    );
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-null-strips-converter (firestore#49)', async () => {
    const production = load('firestore-withconverter-null-strips-converter');
    const pyric = await replayWithConverterNullStripsConverter(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-preserves-untyped-ref-identity (firestore#50)', async () => {
    const production = load('firestore-withconverter-preserves-untyped-ref-identity');
    const pyric = await replayWithConverterPreservesUntypedRefIdentity(
      await servedFirestoreContext(),
    );
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-setdoc-invokes-tofirestore (firestore#51)', async () => {
    const production = load('firestore-withconverter-setdoc-invokes-tofirestore');
    const pyric = await replayWithConverterSetDocInvokesToFirestore(await servedFirestoreContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-getdoc-invokes-fromfirestore (firestore#52)', async () => {
    const production = load('firestore-withconverter-getdoc-invokes-fromfirestore');
    const pyric = await replayWithConverterGetDocInvokesFromFirestore(
      await servedFirestoreContext(),
    );
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-updatedoc-bypasses-converter (firestore#53)', async () => {
    const production = load('firestore-withconverter-updatedoc-bypasses-converter');
    const pyric = await replayWithConverterUpdateDocBypassesConverter(
      await servedFirestoreContext(),
    );
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-collection-method-propagation (firestore#53a)', async () => {
    const production = load('firestore-withconverter-collection-method-propagation');
    const pyric = await replayWithConverterCollectionMethodPropagation(
      await servedFirestoreContext(),
    );
    expectReplay({
      production,
      pyric,
      notCompared: {
        groupQueryEqualUntypedVsTyped: WORKER_UNSUPPORTED_QUERY_EQUAL_REASON,
        groupQueryEqualUntypedVsStripped: WORKER_UNSUPPORTED_QUERY_EQUAL_REASON,
      },
    });
  });

  it('firestore-withconverter-query-method-and-subcollection-isolation (firestore#53b)', async () => {
    const production = load('firestore-withconverter-query-method-and-subcollection-isolation');
    const pyric = await replayWithConverterQueryMethodAndSubcollectionIsolation(
      await servedFirestoreContext(),
    );
    expectReplay({
      production,
      pyric,
      notCompared: {
        queryEqualBaseAndStripped: WORKER_UNSUPPORTED_QUERY_EQUAL_REASON,
        queryEqualBaseAndTyped: WORKER_UNSUPPORTED_QUERY_EQUAL_REASON,
      },
    });
  });
});
