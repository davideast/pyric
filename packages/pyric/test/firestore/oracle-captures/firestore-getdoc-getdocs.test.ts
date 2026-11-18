import { describe, it } from 'bun:test';
import {
  replayGetDocSnapshotShapeMissingAndRef,
  replayGetDocsForEachThisArgAndArity,
  replayGetDocsSnapshotEmptyAndDocRefs,
  replaySnapshotGetDottedAndFieldPath,
} from '../../../../conformance/src/firestore-getdoc-getdocs-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore getDoc and getDocs oracle captures (in-page pyric/firestore)', () => {
  it('firestore-getdoc-snapshot-shape-missing-and-ref (firestore#16, #17, #18, #19)', async () => {
    const production = load('firestore-getdoc-snapshot-shape-missing-and-ref');
    const ctx = inPageContext();
    try {
      const pyric = await replayGetDocSnapshotShapeMissingAndRef(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-getdocs-snapshot-empty-and-doc-refs (firestore#22, #23, #25)', async () => {
    const production = load('firestore-getdocs-snapshot-empty-and-doc-refs');
    const ctx = inPageContext();
    try {
      const pyric = await replayGetDocsSnapshotEmptyAndDocRefs(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-getdocs-foreach-thisarg-and-arity (firestore#22a)', async () => {
    const production = load('firestore-getdocs-foreach-thisarg-and-arity');
    const ctx = inPageContext();
    try {
      const pyric = await replayGetDocsForEachThisArgAndArity(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-snapshot-get-dotted-and-fieldpath (firestore#22a)', async () => {
    const production = load('firestore-snapshot-get-dotted-and-fieldpath');
    const ctx = inPageContext();
    try {
      const pyric = await replaySnapshotGetDottedAndFieldPath(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });
});
