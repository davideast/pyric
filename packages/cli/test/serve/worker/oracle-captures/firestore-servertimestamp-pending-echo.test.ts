import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-servertimestamp-pending-echo.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-servertimestamp-pending-echo, served SharedWorker', async () => {
  expectReplay({
    production: load('firestore-servertimestamp-pending-echo'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});

it('firestore-servertimestamp-pending-echo, served Node host', async () => {
  expectReplay({
    production: load('firestore-servertimestamp-pending-echo'),
    pyric: await scenario.run(await hostedFirestoreContext()),
    pins: [],
  });
});
