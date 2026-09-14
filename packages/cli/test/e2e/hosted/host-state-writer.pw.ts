import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

function startStateWriterFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /shared/greeting { allow read, write: if true; } } }",
      'index.html': '<output id="document">Starting</output><label>Message<input id="message"></label><button id="write">Write</button><output id="written"></output><button id="capture">Capture mirror</button><output id="captured"></output><button id="replay">Replay mirror</button><output id="replayed"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const reference = doc(getFirestore(app), 'shared/greeting');
        onSnapshot(reference, snapshot => {
          document.querySelector('#document').textContent = snapshot.data()?.message ?? 'Empty';
        });
        document.querySelector('#write').onclick = async () => {
          const message = document.querySelector('#message').value;
          await setDoc(reference, { message });
          document.querySelector('#written').textContent = message;
        };
        const initialization = await fetch('/__pyric/init.json').then(response => response.json());
        const headers = {
          'content-type': 'application/json',
          'x-pyric-writer': 'legacy-state-mirror',
          'x-pyric-session-token': initialization.sessionToken,
        };
        let mirror;
        document.querySelector('#capture').onclick = async () => {
          const response = await fetch('/__pyric/state?section=firestore', { headers });
          mirror = await response.text();
          document.querySelector('#captured').textContent = String(response.status);
        };
        document.querySelector('#replay').onclick = async () => {
          const response = await fetch('/__pyric/state?section=firestore', { method: 'POST', headers, body: mirror });
          document.querySelector('#replayed').textContent = String(response.status);
        };
      `,
    },
  });
}

test('a legacy state mirror cannot replace an acknowledged hosted SDK value', async ({ browser }) => {
  const fixture = await startStateWriterFixture();
  const context = await browser.newContext();
  try {
    const writer = await context.newPage();
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');
    await writer.getByLabel('Message', { exact: true }).fill('Older mirror value');
    await writer.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(writer.locator('#written')).toHaveText('Older mirror value');
    await writer.getByRole('button', { name: 'Capture mirror', exact: true }).click();
    await expect(writer.locator('#captured')).toHaveText('200');
    await writer.getByLabel('Message', { exact: true }).fill('Acknowledged hosted value');
    await writer.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(writer.locator('#written')).toHaveText('Acknowledged hosted value');
    await writer.getByRole('button', { name: 'Replay mirror', exact: true }).click();
    await expect(writer.locator('#replayed')).toHaveText('423');
    await expect(writer.locator('#document')).toHaveText('Acknowledged hosted value');

    const exit = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exit;
    await context.close();
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await browser.newPage();
      try {
        await reader.goto(fixture.info.url);
        await expect(reader.locator('#document')).toHaveText('Acknowledged hosted value');
      } finally {
        await reader.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await context.close();
    await fixture.stop();
  }
});

test('default SharedWorker persistence can hand its acknowledged data to a restarted host', async ({ browser }) => {
  const fixture = await startStateWriterFixture(['--persist', '--no-capture']);
  const context = await browser.newContext();
  try {
    const writer = await context.newPage();
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');
    await writer.getByLabel('Message', { exact: true }).fill('Persisted by SharedWorker');
    await writer.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(writer.locator('#written')).toHaveText('Persisted by SharedWorker');
    const exit = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exit;
    await context.close();
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await browser.newPage();
      try {
        await reader.goto(fixture.info.url);
        await expect(reader.locator('#document')).toHaveText('Persisted by SharedWorker');
      } finally {
        await reader.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await context.close();
    await fixture.stop();
  }
});
