import { describe, it } from 'bun:test';
import {
  replayCrudConverterDeleteAndAddDoc,
  replayOnSnapshotFilteredTimestampAndRefs,
  replayQueryCursorsEndAtSnapAndPagination,
} from '../../../../conformance/src/firestore-crud-cursors-listeners-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore CRUD, cursor pagination, and filtered onSnapshot oracle captures (in-page pyric/firestore)', () => {
  it('firestore-crud-converter-delete-and-adddoc (firestore#35, #38, #41, #44)', async () => {
    const production = load('firestore-crud-converter-delete-and-adddoc');
    const ctx = inPageContext();
    try {
      const pyric = await replayCrudConverterDeleteAndAddDoc(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-query-cursors-endat-snap-and-pagination (firestore#72, #73)', async () => {
    const production = load('firestore-query-cursors-endat-snap-and-pagination');
    const ctx = inPageContext();
    try {
      const pyric = await replayQueryCursorsEndAtSnapAndPagination(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-onsnapshot-filtered-timestamp-and-refs (firestore#81a, #81b, #86)', async () => {
    const production = load('firestore-onsnapshot-filtered-timestamp-and-refs');
    const ctx = inPageContext();
    try {
      const pyric = await replayOnSnapshotFilteredTimestampAndRefs(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });
});
