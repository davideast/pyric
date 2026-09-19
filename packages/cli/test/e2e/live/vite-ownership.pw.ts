import { test } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pyric } from '../../../dist/vite.js';
import { startLiveEmulators } from './emulators.js';
import { prepareLiveFixture } from './fixture.js';
import { expectLiveRead } from './read-proof.js';

test('Vite resolves a live read to the real SDK and records one observation', async ({ browser, request }) => {
  const backend = await startLiveEmulators();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-vite-')));
  try {
    prepareLiveFixture(dir, backend);
    const options = { live: true, ui: false };
    const server = await createServer({
      root: dir,
      configFile: false,
      plugins: [pyric(options)],
      server: { host: '127.0.0.1', port: 0 },
      cacheDir: join(dir, '.vite'),
      logLevel: 'silent',
    });
    try {
      await server.listen();
      const url = server.resolvedUrls?.local[0];
      const hasNoUrl = url === undefined;
      if (hasNoUrl) throw new Error('The live Vite fixture did not expose its listening URL.');
      const context = await browser.newContext();
      try {
        await expectLiveRead(context, request, url.replace(/\/$/, ''), backend);
      } finally {
        await context.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await backend.stop();
  }
});
