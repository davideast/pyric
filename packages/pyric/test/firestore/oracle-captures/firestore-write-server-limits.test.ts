import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-write-server-limits.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages, type Pin } from './support.ts';

const FINDING = 'FW-14: the server refuses writes past its documented limits';
const refused = { ok: false, sync: false, code: 'invalid-argument', name: 'FirebaseError' };
const stored = (key: string): Pin => ({ key, finding: FINDING, production: refused, pyric: { ok: true } });

it('firestore-write-server-limits', async () => {
  const production = withoutMessages(load('firestore-write-server-limits'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [
      stored('document over 1 MiB'),
      stored("document id '__x__'"),
      stored("document id '.'"),
      stored("document id '..'"),
      stored('document id of 1,501 bytes'),
      stored('field name of 1,501 bytes'),
      stored('501 transforms on one document'),
    ],
  });
});
