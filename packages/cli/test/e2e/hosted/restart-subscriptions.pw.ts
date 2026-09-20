import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

for (const observed of ['rtdb', 'presence', 'events']) {
  test(`${observed} subscription delivers after a host process restart without a page reload`, async ({ browser }) => {
    const fixture = await startSoakServe({
      flags: ['--hosted', '--no-capture'],
      extraFiles: {
        'firebase.json': JSON.stringify({ database: { rules: 'database.rules.json' } }),
        'database.rules.json': JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }),
        'index.html': '<output id="connected"></output><output id="rtdb"></output><output id="presence"></output><output id="events"></output><script type="module" src="/main.js"></script><script type="module" src="/probe.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { getAuth, signInAnonymously } from 'firebase/auth';
          import { getDatabase, onValue, ref } from 'firebase/database';
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
          await signInAnonymously(getAuth(app));
          const db = getDatabase(app);
          onValue(ref(db, '.info/connected'), snapshot => {
            document.querySelector('#connected').textContent = String(snapshot.val());
          });
          onValue(ref(db, 'restart/value'), snapshot => {
            document.querySelector('#rtdb').textContent = snapshot.val() ?? 'Empty';
          });
        `,
      },
      prepare(dir) {
        buildSync({
          entryPoints: [fileURLToPath(new URL('./restart-subscription-probe.ts', import.meta.url))],
          outfile: join(dir, 'probe.js'), bundle: true, platform: 'browser', format: 'esm',
        });
      },
    });
    const page = await browser.newPage();
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#rtdb')).toHaveText('Empty');
      await expect(page.locator('#presence')).toContainText('clientId');
      await expect(page.locator('#events')).not.toBeEmpty();
      const exited = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await exited;
      await expect(page.locator('#connected')).toHaveText('false');
      const replacement = startHost(fixture.dir, fixture.info.port);
      try {
        expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
        await expect(page.locator('#connected')).toHaveText('true', { timeout: 10_000 });
        const writer = await browser.newPage();
        try {
          await writer.goto(`${fixture.info.url}/?after-restart`);
          await expect(writer.locator('#connected')).toHaveText('true');
          await writer.evaluate(async () => {
            const sdk = await import('firebase/database');
            await sdk.set(sdk.ref(sdk.getDatabase(), 'restart/value'), 'After restart');
            await sdk.set(sdk.ref(sdk.getDatabase(), 'restart/after-restart-marker'), true);
          });
          const expected = { rtdb: 'After restart', presence: '?after-restart', events: 'after-restart-marker' }[observed]!;
          await expect(page.locator(`#${observed}`)).toContainText(expected);
        } finally {
          await writer.close();
        }
      } finally {
        await replacement.stop();
      }
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
