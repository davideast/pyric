import { describe, expect, it } from 'bun:test';
import { scenario as localWriteMetadataScenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-listener-local-write-metadata.scenario.ts';
import { scenario as multiDocPendingWritesScenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-doc-pending-writes.scenario.ts';
import { scenario as rtdbOrderScenario } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-remote-update-event-order.scenario.ts';
import { runInPage as runRtdbInPage } from '../../../../pyric/test/database/cdd/capture-replay.ts';
import { runInPage as runFirestoreInPage } from '../../../../pyric/test/firestore/oracle-captures/support.ts';
import {
  restoreSharedWorker,
  servedFirestoreContext,
  servedRtdbContext,
} from './oracle-captures/support.ts';

restoreSharedWorker();

describe('Cross-plane Firestore listener metadata and RTDB event ordering', () => {
  it('preserves hasPendingWrites on local write echoes and reports modified on metadata ack docChanges({ includeMetadataChanges: true }) across planes', async () => {
    const inPage = await runFirestoreInPage(localWriteMetadataScenario);
    const served = await localWriteMetadataScenario.run(await servedFirestoreContext());

    const expectedDocDefault = [
      { exists: false, pw: false, fc: false },
      { exists: true, pw: true, fc: false },
    ];
    const expectedDocMeta = [
      { exists: false, pw: false, fc: false },
      { exists: true, pw: true, fc: false },
      { exists: true, pw: false, fc: false },
    ];
    const expectedQDefault = [
      { size: 0, pw: false, changes: [] },
      { size: 1, pw: true, changes: ['added:a:true'] },
    ];
    const expectedQMeta = [
      { size: 0, pw: false, fc: false, changes: [] },
      { size: 1, pw: true, fc: false, changes: ['added:a:true'] },
      { size: 1, pw: false, fc: false, changes: ['modified:a:false'] },
    ];

    expect(inPage.docDefault).toEqual(expectedDocDefault);
    expect(served.docDefault).toEqual(expectedDocDefault);
    expect(inPage.docMeta).toEqual(expectedDocMeta);
    expect(served.docMeta).toEqual(expectedDocMeta);
    expect(inPage.qDefault).toEqual(expectedQDefault);
    expect(served.qDefault).toEqual(expectedQDefault);
    expect(inPage.qMeta).toEqual(expectedQMeta);
    expect(served.qMeta).toEqual(expectedQMeta);
  });

  it('scopes hasPendingWrites to the written document in multi-doc query snapshots across planes', async () => {
    const inPage = await runFirestoreInPage(multiDocPendingWritesScenario);
    const served = await multiDocPendingWritesScenario.run(await servedFirestoreContext());
    const expected = [
      { pw: false, docs: [['a', false]] },
      { pw: true, docs: [['a', false], ['z', true]] },
      { pw: false, docs: [['a', false], ['z', false]] },
    ];
    expect(inPage.events).toEqual(expected);
    expect(served.events).toEqual(expected);
  });

  it('fires RTDB remote update and setPriority listener events in production SyncTree order across planes', async () => {
    const inPage = await runRtdbInPage(rtdbOrderScenario);
    const served = await rtdbOrderScenario.run(await servedRtdbContext());
    const expectedLog = [
      '-- update',
      'A changed x', 'A value',
      'R removed c', 'R added d', 'R changed a', 'R changed b', 'R value',
      'Q moved b', 'Q moved a', 'Q changed b', 'Q changed a',
      '-- setPriority a 9',
      'A value', 'R changed a', 'R value', 'Q moved a', 'Q changed a', 'L moved a',
    ];
    expect(inPage.log).toEqual(expectedLog);
    expect(served.log).toEqual(expectedLog);
  });
});
