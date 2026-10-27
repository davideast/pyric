import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-offline-denied-write.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

const FINDING = 'FW-17: an offline write the rules deny stays pending with a local snapshot, then rejects after reconnect';
const cachedAbsent = { at: 'snapshot', exists: false, pending: false, fromCache: true };
const localWrite = { at: 'snapshot', exists: true, pending: true, fromCache: true };
const listenDenied = { at: 'listenError', code: 'permission-denied' };

it('firestore-offline-denied-write', async () => {
  const production = load('firestore-offline-denied-write');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [
      {
        key: 'whileOffline',
        finding: FINDING,
        production: { state: 'pending', events: [cachedAbsent, localWrite] },
        pyric: { state: 'rejected permission-denied', events: [listenDenied] },
      },
      {
        key: 'events',
        finding: FINDING,
        production: [cachedAbsent, localWrite, listenDenied],
        pyric: [listenDenied],
      },
    ],
  });
});
