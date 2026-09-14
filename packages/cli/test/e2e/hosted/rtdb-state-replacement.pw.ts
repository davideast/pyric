import { test, expect, type Browser } from '@playwright/test';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { isBridgeMessage, type WorkerOpPayload } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

/** Exercise the published remote consumer against the fixture's real host. */
async function control(url: string, operation: WorkerOpPayload): Promise<unknown> {
  const remote = await connectRemoteSandbox({ url });
  try {
    return await remote.channel.op(operation);
  } finally {
    remote.close();
  }
}

test('imported RTDB state survives loss and deletion of a previously registered connection', async ({ browser }) => {
  await assertReplacementSurvivesDisconnect(browser, { kind: 'import' });
});

test('restored RTDB checkpoint survives loss and deletion of a previously registered connection', async ({ browser }) => {
  await assertReplacementSurvivesDisconnect(browser, { kind: 'restore' });
});

test('reset RTDB state survives loss and deletion of a previously registered connection', async ({ browser }) => {
  await assertReplacementSurvivesDisconnect(browser, { kind: 'reset' });
});

test('a fresh disconnect registration after import still executes', async ({ browser }) => {
  await assertReplacementSurvivesDisconnect(browser, { kind: 'import' }, true);
});

test('a rejected import preserves the existing disconnect registration', async ({ browser }) => {
  await assertReplacementSurvivesDisconnect(browser, { kind: 'invalid-import', bundle: 'not a state bundle' });
});

const refusedImports = [
  {
    name: 'an import missing its metadata record',
    bundle: '{"format":"pyric-v3-records","records":{"00":{"docs":{}}}}',
  },
  {
    name: 'an unsupported import version',
    bundle: '{"format":"pyric-v3-records","records":{"meta":{"version":4,"savedAt":0,"services":{}}}}',
  },
  {
    name: 'a corrupt import bucket',
    bundle: '{"format":"pyric-v3-records","records":{"meta":{"version":3,"savedAt":0,"services":{}},"00":{"docs":{"items/one":{"count":1}},"checksum":0}}}',
  },
  {
    name: 'an import with an invalid services map',
    bundle: '{"format":"pyric-v3-records","records":{"meta":{"version":3,"savedAt":0,"services":[]}}}',
  },
  {
    name: 'an import with an invalid document root',
    bundle: '{"format":"pyric-v3-records","records":{"meta":{"version":3,"savedAt":0,"services":{}},"00":{"docs":{"items/one":[]}}}}',
  },
];

for (const scenario of refusedImports) {
  test(`${scenario.name} preserves data and disconnect intent`, async ({ browser }) => {
    await assertReplacementSurvivesDisconnect(browser, { kind: 'invalid-import', bundle: scenario.bundle });
  });
  test(`SharedWorker preserves SDK data after ${scenario.name}`, async ({ browser }) => {
    await assertSharedWorkerImportRefusal(browser, scenario.bundle);
  });
}

async function assertSharedWorkerImportRefusal(browser: Browser, bundle: string): Promise<void> {
  const serve = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /items/one { allow read, write: if true; } } }",
      'index.html': '<output>Starting</output><button>Read document</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const reference = doc(db, 'items/one');
        await setDoc(reference, { message: 'Saved' });
        document.querySelector('output').textContent = 'Ready';
        document.querySelector('button').addEventListener('click', async () => {
          const snapshot = await getDoc(reference);
          document.querySelector('output').textContent = snapshot.data()?.message ?? 'Missing';
        });
      `,
    },
  });
  const context = await browser.newContext();
  const errors: string[] = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(serve.info.url);
    await expect(page.locator('output')).toHaveText('Ready');
    await waitForPeer(serve.info.url);
    await expect(control(serve.info.url, { method: 'importState', bundle })).rejects.toMatchObject({ code: 'invalid-argument' });
    await page.getByRole('button', { name: 'Read document', exact: true }).click();
    await expect(page.locator('output')).toHaveText('Saved');
    expect(errors).toEqual([]);
  } finally {
    await context.close().finally(() => serve.stop());
  }
}

type StateReplacement =
  | { kind: 'import' | 'restore' | 'reset' }
  | { kind: 'invalid-import'; bundle: string };

async function assertReplacementSurvivesDisconnect(
  browser: Browser,
  replacement: StateReplacement,
  registersFreshIntent = false,
): Promise<void> {
  const serve = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firebase.json': '{"database":{"rules":"database.rules.json"}}',
      'database.rules.json': '{"rules":{"presence":{".read":true,".write":true}}}',
      'index.html': '<output>Starting</output><button id="register">Register disconnect</button><button id="fresh">Register fresh disconnect</button><button id="delete">Delete app</button><script type="module" src="/owner.js"></script>',
      'observer.html': '<output id="value">Starting</output><output id="private"></output><button>Read private data</button><script type="module" src="/observer.js"></script>',
      'owner.js': `
        import { deleteApp, initializeApp } from 'firebase/app';
        import { getDatabase, onDisconnect, ref, set } from 'firebase/database';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const status = ref(getDatabase(app), 'presence/owner');
        await set(status, 'saved');
        document.querySelector('output').textContent = 'Ready';
        document.querySelector('#register').addEventListener('click', async () => {
          await set(status, 'current');
          await onDisconnect(status).set('obsolete');
          document.querySelector('output').textContent = 'Registered';
        });
        document.querySelector('#fresh').addEventListener('click', async () => {
          await onDisconnect(status).set('fresh');
          document.querySelector('output').textContent = 'Fresh registration';
        });
        document.querySelector('#delete').addEventListener('click', async () => {
          await deleteApp(app);
          document.querySelector('output').textContent = 'Deleted';
        });
      `,
      'observer.js': `
        import { initializeApp } from 'firebase/app';
        import { get, getDatabase, onValue, ref } from 'firebase/database';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        onValue(ref(getDatabase(app), 'presence/owner'), snapshot => {
          document.querySelector('#value').textContent = JSON.stringify(snapshot.val());
        }, error => {
          document.querySelector('#value').textContent = error.code;
        });
        document.querySelector('button').addEventListener('click', async () => {
          try {
            await get(ref(getDatabase(app), 'secrets'));
            document.querySelector('#private').textContent = 'Unexpected access';
          } catch (error) {
            document.querySelector('#private').textContent = error.code;
          }
        });
      `,
    },
  });
  const ownerContext = await browser.newContext();
  const observerContext = await browser.newContext();
  const resumed = Promise.withResolvers<void>();
  let interrupted = false;
  let cutConnection: (() => Promise<void>) | undefined;
  const errors: string[] = [];
  try {
    await ownerContext.routeWebSocket('**/*', (route) => {
      const server = route.connectToServer();
      route.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isRecognizedFrame = isBridgeMessage(frame);
        if (isRecognizedFrame) {
          const isWorkerRequest = frame.type === 'worker-message';
          if (isWorkerRequest) {
            const request = frame.message;
            const registersDisconnect = request.t === 'op' && request.method === 'rtdb.onDisconnectSet';
            if (registersDisconnect) {
              cutConnection = async () => {
                interrupted = true;
                await route.close({ code: 1001, reason: 'Fixture connection loss after import' });
                await server.close();
              };
            }
          }
        }
        server.send(data);
      });
      server.onMessage((data) => {
        const frame: unknown = JSON.parse(data.toString());
        const isRecognizedFrame = isBridgeMessage(frame);
        if (isRecognizedFrame) {
          const isReattached = interrupted && frame.type === 'attach-ack';
          if (isReattached) resumed.resolve();
        }
        route.send(data);
      });
    });
    const owner = await ownerContext.newPage();
    owner.on('pageerror', error => errors.push(error.message));
    await owner.goto(serve.info.url);
    await expect(owner.locator('output')).toHaveText('Ready');
    const saved = await control(serve.info.url, { method: 'exportState' });
    const hasBundle = typeof saved === 'object' && saved !== null && 'bundle' in saved;
    const isMissingBundle = !hasBundle;
    if (isMissingBundle) throw new Error('Host did not export a state bundle');
    const bundle = saved.bundle;
    const isInvalidBundle = typeof bundle !== 'string';
    if (isInvalidBundle) throw new Error('Host exported a non-string state bundle');
    const usesCheckpoint = replacement.kind === 'restore';
    if (usesCheckpoint) {
      const checkpoint = await control(serve.info.url, { method: 'checkpoint', name: 'saved' });
      expect(checkpoint).toMatchObject({ ok: true });
    }
    await owner.getByRole('button', { name: 'Register disconnect', exact: true }).click();
    await expect(owner.locator('output')).toHaveText('Registered');
    const observer = await observerContext.newPage();
    observer.on('pageerror', error => errors.push(error.message));
    await observer.goto(`${serve.info.url}/observer.html`);
    await expect(observer.locator('#value')).toHaveText('"current"');

    let replacedValue = '"saved"';
    let disconnectedValue = '"saved"';
    switch (replacement.kind) {
      case 'import':
        await control(serve.info.url, { method: 'importState', bundle });
        break;
      case 'restore': {
        const restored = await control(serve.info.url, { method: 'restore', name: 'saved' });
        expect(restored).toMatchObject({ ok: true });
        break;
      }
      case 'reset': {
        const reset = await control(serve.info.url, { method: 'resetAll' });
        expect(reset).toEqual({ errors: [] });
        replacedValue = 'null';
        disconnectedValue = 'null';
        break;
      }
      case 'invalid-import':
        await expect(control(serve.info.url, { method: 'importState', bundle: replacement.bundle })).rejects.toMatchObject({ code: 'invalid-argument' });
        replacedValue = '"current"';
        disconnectedValue = '"obsolete"';
        break;
    }
    await expect(observer.locator('#value')).toHaveText(replacedValue);
    if (registersFreshIntent) {
      await owner.getByRole('button', { name: 'Register fresh disconnect', exact: true }).click();
      await expect(owner.locator('output')).toHaveText('Fresh registration');
      disconnectedValue = '"fresh"';
    }
    const cut = cutConnection;
    const isMissingConnection = cut === undefined;
    if (isMissingConnection) throw new Error('Owner never registered disconnect work');
    await cut();
    await resumed.promise;
    // Deletion is acknowledged after accepted work and the disconnect drain.
    await owner.getByRole('button', { name: 'Delete app', exact: true }).click();
    await expect(owner.locator('output')).toHaveText('Deleted');
    await observer.reload();
    await expect(observer.locator('#value')).toHaveText(disconnectedValue);
    await observer.getByRole('button', { name: 'Read private data', exact: true }).click();
    await expect(observer.locator('#private')).toHaveText('PERMISSION_DENIED');
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([ownerContext.close(), observerContext.close()]).finally(() => serve.stop());
  }
}
