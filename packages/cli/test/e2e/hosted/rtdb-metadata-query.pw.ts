import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

function startMetadataQueryFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firebase.json': '{"database":{"rules":"database.rules.json"}}',
      'database.rules.json': '{"rules":{".read":"auth != null",".write":"auth != null"}}',
      'index.html': '<output id="value">Starting</output><output id="keys"></output><output id="history"></output><output id="connected"></output><output id="parent"></output><button id="stop">Stop query</button><button id="offline">Go offline</button><button id="online">Go online</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { equalTo, getDatabase, goOffline, goOnline, off, onValue, orderByKey, query, ref, set } from 'firebase/database';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        await signInAnonymously(getAuth(app));
        const db = getDatabase(app);
        await set(ref(db, 'metadata/ready'), true);
        document.querySelector('#offline').addEventListener('click', () => goOffline(db));
        document.querySelector('#online').addEventListener('click', () => goOnline(db));
        onValue(ref(db, '.info/connected'), snapshot => {
          document.querySelector('#connected').textContent = String(snapshot.val());
        });
        const field = new URLSearchParams(location.search).get('field') ?? 'connected';
        const selected = query(ref(db, '.info'), orderByKey(), equalTo(field));
        document.querySelector('#stop').addEventListener('click', () => off(selected, 'value'));
        onValue(ref(db, '.info'), snapshot => {
          document.querySelector('#parent').textContent = JSON.stringify(snapshot.val());
        });
        const history = [];
        onValue(selected, snapshot => {
          const value = snapshot.val();
          const keys = [];
          snapshot.forEach(child => { keys.push(child.key); });
          history.push(value);
          document.querySelector('#value').textContent = JSON.stringify(value);
          document.querySelector('#keys').textContent = JSON.stringify(keys);
          document.querySelector('#history').textContent = JSON.stringify(history);
        });
      `,
    },
  });
}

for (const hosting of ['hosted', 'SharedWorker', 'in-page']) {
  const usesHostedSandbox = hosting === 'hosted';
  const usesInPageSandbox = hosting === 'in-page';
  const flags = usesHostedSandbox ? ['--hosted', '--no-capture'] : ['--no-capture'];

  test(`${hosting} metadata queries filter the parent and follow connectivity`, async ({ page }) => {
    const serve = await startMetadataQueryFixture(flags);
    try {
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url);
      await expect(page.locator('#value')).toHaveText('{"connected":true}');
      await expect(page.locator('#keys')).toHaveText('["connected"]');

      await page.getByRole('button', { name: 'Go offline', exact: true }).click();

      await expect(page.locator('#value')).toHaveText('{"connected":false}');
      await page.getByRole('button', { name: 'Go online', exact: true }).click();
      await expect(page.locator('#history')).toHaveText('[{"connected":true},{"connected":false},{"connected":true}]');
    } finally {
      await serve.stop();
    }
  });

  test(`${hosting} metadata queries do not redeliver an unchanged selection`, async ({ page }) => {
    const serve = await startMetadataQueryFixture(flags);
    try {
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url + '?field=serverTimeOffset');
      await expect(page.locator('#history')).toHaveText('[{"serverTimeOffset":0}]');

      await page.getByRole('button', { name: 'Go offline', exact: true }).click();
      await expect(page.locator('#connected')).toHaveText('false');
      await page.getByRole('button', { name: 'Go online', exact: true }).click();
      await expect(page.locator('#connected')).toHaveText('true');

      await expect(page.locator('#history')).toHaveText('[{"serverTimeOffset":0}]');
    } finally {
      await serve.stop();
    }
  });

  test(`${hosting} off removes the filtered metadata listener and preserves the parent listener`, async ({ page }) => {
    const serve = await startMetadataQueryFixture(flags);
    try {
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url);
      await expect(page.locator('#history')).toHaveText('[{"connected":true}]');
      await expect(page.locator('#parent')).toHaveText('{"connected":true,"serverTimeOffset":0}');

      await page.getByRole('button', { name: 'Stop query', exact: true }).click();
      await page.getByRole('button', { name: 'Go offline', exact: true }).click();

      await expect(page.locator('#parent')).toHaveText('{"connected":false,"serverTimeOffset":0}');
      await expect(page.locator('#history')).toHaveText('[{"connected":true}]');
    } finally {
      await serve.stop();
    }
  });

  test(`${hosting} an empty metadata query reports null once while the parent changes`, async ({ page }) => {
    const serve = await startMetadataQueryFixture(flags);
    try {
      if (usesInPageSandbox) {
        await page.addInitScript(() => {
          Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
        });
      }
      await page.goto(serve.info.url + '?field=missing');
      await expect(page.locator('#value')).toHaveText('null');
      await expect(page.locator('#keys')).toHaveText('[]');

      await page.getByRole('button', { name: 'Go offline', exact: true }).click();
      await expect(page.locator('#connected')).toHaveText('false');
      await page.getByRole('button', { name: 'Go online', exact: true }).click();
      await expect(page.locator('#connected')).toHaveText('true');

      await expect(page.locator('#history')).toHaveText('[null]');
    } finally {
      await serve.stop();
    }
  });
}
