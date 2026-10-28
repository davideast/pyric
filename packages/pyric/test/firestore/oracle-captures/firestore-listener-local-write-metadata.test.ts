import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-listener-local-write-metadata.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

const PENDING = "FL-20: the local write's echo reports hasPendingWrites true on the doc";
const absent = { exists: false, pw: false, fc: false };

it('firestore-listener-local-write-metadata', async () => {
  const production = load('firestore-listener-local-write-metadata');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [
      {
        key: 'docDefault',
        finding: PENDING,
        production: [absent, { exists: true, pw: true, fc: false }],
        pyric: [absent, { exists: true, pw: false, fc: false }],
      },
      {
        key: 'docMeta',
        finding: PENDING,
        production: [absent, { exists: true, pw: true, fc: false }, { exists: true, pw: false, fc: false }],
        pyric: [absent, { exists: true, pw: false, fc: false }, { exists: true, pw: false, fc: false }],
      },
      {
        key: 'qDefault',
        finding: PENDING,
        production: [{ size: 0, pw: false, changes: [] }, { size: 1, pw: true, changes: ['added:a:true'] }],
        pyric: [{ size: 0, pw: false, changes: [] }, { size: 1, pw: true, changes: ['added:a:false'] }],
      },
      {
        key: 'qMeta',
        finding: `${PENDING}; FL-21: docChanges({ includeMetadataChanges: true }) on the ack lists the doc as modified`,
        production: [
          { size: 0, pw: false, fc: false, changes: [] },
          { size: 1, pw: true, fc: false, changes: ['added:a:true'] },
          { size: 1, pw: false, fc: false, changes: ['modified:a:false'] },
        ],
        pyric: [
          { size: 0, pw: false, fc: false, changes: [] },
          { size: 1, pw: true, fc: false, changes: ['added:a:false'] },
          { size: 1, pw: false, fc: false, changes: [] },
        ],
      },
    ],
  });
});
