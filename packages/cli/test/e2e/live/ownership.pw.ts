import { test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startLiveEmulators } from './emulators.js';
import { prepareLiveFixture } from './fixture.js';
import { expectLiveRead } from './read-proof.js';

test('a normal app read uses real SDK ownership and records one observation', async ({ browser, request }) => {
  const backend = await startLiveEmulators();
  try {
    const serve = await startSoakServe({
      flags: ['--live'],
      prepare: (dir) => prepareLiveFixture(dir, backend),
    });
    const context = await browser.newContext();
    try {
      await expectLiveRead(context, request, serve.info.url, backend);
    } finally {
      await context.close();
      await serve.stop();
    }
  } finally {
    await backend.stop();
  }
});
