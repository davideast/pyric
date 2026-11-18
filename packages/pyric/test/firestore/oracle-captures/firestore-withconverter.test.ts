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
} from '../../../../conformance/src/firestore-withconverter-replay.ts';
import { expectReplay, inPageContext, load, type Pin } from './support.ts';

const FREE_WITHCONVERTER_EXPORT_PIN: Pin = {
  key: 'hasTopLevelWithConverterExport',
  finding: 'pyric/firestore retains legacy free withConverter(ref, converter) alias alongside .withConverter() method',
  production: false,
  pyric: true,
};

describe('Firestore withConverter oracle captures (in-page pyric/firestore)', () => {
  it('firestore-withconverter-doc-roundtrip (firestore#46)', async () => {
    const production = load('firestore-withconverter-doc-roundtrip');
    const pyric = await replayWithConverterDocRoundtrip(inPageContext());
    expectReplay({ production, pyric, pins: [FREE_WITHCONVERTER_EXPORT_PIN] });
  });

  it('firestore-withconverter-collection-propagates-to-doc (firestore#47)', async () => {
    const production = load('firestore-withconverter-collection-propagates-to-doc');
    const pyric = await replayWithConverterCollectionPropagatesToDoc(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-collection-propagates-to-query-getdocs (firestore#48)', async () => {
    const production = load('firestore-withconverter-collection-propagates-to-query-getdocs');
    const pyric = await replayWithConverterCollectionPropagatesToQueryGetDocs(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-null-strips-converter (firestore#49)', async () => {
    const production = load('firestore-withconverter-null-strips-converter');
    const pyric = await replayWithConverterNullStripsConverter(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-preserves-untyped-ref-identity (firestore#50)', async () => {
    const production = load('firestore-withconverter-preserves-untyped-ref-identity');
    const pyric = await replayWithConverterPreservesUntypedRefIdentity(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-setdoc-invokes-tofirestore (firestore#51)', async () => {
    const production = load('firestore-withconverter-setdoc-invokes-tofirestore');
    const pyric = await replayWithConverterSetDocInvokesToFirestore(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-getdoc-invokes-fromfirestore (firestore#52)', async () => {
    const production = load('firestore-withconverter-getdoc-invokes-fromfirestore');
    const pyric = await replayWithConverterGetDocInvokesFromFirestore(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-updatedoc-bypasses-converter (firestore#53)', async () => {
    const production = load('firestore-withconverter-updatedoc-bypasses-converter');
    const pyric = await replayWithConverterUpdateDocBypassesConverter(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-collection-method-propagation (firestore#53a)', async () => {
    const production = load('firestore-withconverter-collection-method-propagation');
    const pyric = await replayWithConverterCollectionMethodPropagation(inPageContext());
    expectReplay({ production, pyric });
  });

  it('firestore-withconverter-query-method-and-subcollection-isolation (firestore#53b)', async () => {
    const production = load('firestore-withconverter-query-method-and-subcollection-isolation');
    const pyric = await replayWithConverterQueryMethodAndSubcollectionIsolation(inPageContext());
    expectReplay({ production, pyric });
  });
});
