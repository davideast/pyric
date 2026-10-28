import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-transaction-client-checks.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages } from './support.ts';

const invalid = { code: 'invalid-argument', name: 'FirebaseError' };

it('firestore-transaction-client-checks', async () => {
  const production = withoutMessages(load('firestore-transaction-client-checks'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [
      {
        key: 'updateAfterReadMissing',
        finding: 'FW-7: update after reading a missing doc fails invalid-argument',
        production: { error: invalid, exists: false },
        pyric: { error: { code: 'not-found', name: 'FirebaseError' }, exists: false },
      },
      {
        key: 'swallowedReadAfterWrite',
        finding: 'FW-6: a swallowed read-after-write error still fails the transaction and writes nothing',
        production: { value: null, error: invalid, written: false },
        pyric: { value: 'done', error: null, written: true },
      },
      {
        key: 'readAfterWrite',
        finding: 'FW-7: read-after-write fails invalid-argument with a FirebaseError',
        production: { inner: invalid, outer: invalid },
        pyric: { inner: { name: 'ReadAfterWriteError' }, outer: { code: 'failed-precondition', name: 'FirebaseError' } },
      },
    ],
  });
});
