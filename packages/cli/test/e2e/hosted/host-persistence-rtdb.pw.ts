import { setPersistenceWritable } from './persistence-fault.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const refusedMutations = [
  { name: 'write', call: "set(reference, 'Must not execute')" },
  { name: 'removal', call: 'remove(reference)' },
];

for (const mutation of refusedMutations) {
  test(`an unhealthy host refuses an RTDB SDK ${mutation.name} before changing its value`, async ({ page }) => {
    const serve = await startSoakServe({
      flags: ['--hosted', '--no-capture'],
      extraFiles: {
        'firebase.json': '{"database":{"rules":"database.rules.json"}}',
        'database.rules.json': '{"rules":{"shared":{".read":true,".write":true}}}',
        'index.html': '<output id="value">Starting</output><button id="first">First write</button><output id="first-result"></output><button id="second">Second write</button><output id="second-result"></output><script type="module" src="/main.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { getDatabase, onValue, ref, remove, set } from 'firebase/database';
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
          const reference = ref(getDatabase(app), 'shared/value');
          onValue(reference, snapshot => {
            document.querySelector('#value').textContent = snapshot.val() ?? 'Empty';
          });
          async function write(operation, output) {
            try {
              await operation();
              output.textContent = 'Written';
            } catch (error) {
              output.textContent = error.code;
            }
          }
          document.querySelector('#first').onclick = () => write(() => set(reference, 'Committed in memory'), document.querySelector('#first-result'));
          document.querySelector('#second').onclick = () => write(() => ${mutation.call}, document.querySelector('#second-result'));
        `,
      },
    });
    const stateDirectory = join(serve.dir, '.pyric', 'state');
    try {
      await page.goto(serve.info.url);
      await expect(page.locator('#value')).toHaveText('Empty');
      mkdirSync(stateDirectory, { recursive: true });
      setPersistenceWritable(stateDirectory, false);
      await page.getByRole('button', { name: 'First write' }).click();
      await expect(page.locator('#first-result')).toHaveText('committed-but-not-durable');
      await expect(page.locator('#value')).toHaveText('Committed in memory');
      await page.getByRole('button', { name: 'Second write' }).click();
      await expect(page.locator('#second-result')).toHaveText('persistence-unhealthy');
      await expect(page.locator('#value')).toHaveText('Committed in memory');
    } finally {
      setPersistenceWritable(stateDirectory, true);
      await serve.stop();
    }
  });
}
