import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import { CLI_PATH, startSoakServe } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';
import { startHost } from './host-process.js';

for (const mode of ['hosted', 'sharedworker', 'inpage']) {
  test(`${mode}: deleting an app settles accepted work and ends its listener`, async ({ page }) => {
    test.setTimeout(25_000);
    let heldResponse: ServerResponse | undefined;
    const upstream = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      const isPreflight = request.method === 'OPTIONS';
      if (isPreflight) {
        response.writeHead(204);
        response.end();
        return;
      }
      request.resume();
      heldResponse = response;
    });
    function release(): void {
      const response = heldResponse;
      const cannotReply = response === undefined || response.writableEnded;
      if (cannotReply) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: 'disposal', object: 'chat.completion', created: 0, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Finished' }, finish_reason: 'stop' }],
      }));
    }
    let fixture: Awaited<ReturnType<typeof startSoakServe>> | undefined;
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The local upstream has no address.');
      const isHosted = mode === 'hosted';
      const isSharedWorker = mode === 'sharedworker';
      let selectedMode: 'hosted' | 'sharedworker' | 'inpage' = 'inpage';
      if (isHosted) selectedMode = 'hosted';
      if (isSharedWorker) selectedMode = 'sharedworker';
      const { flags, expectedMode } = await prepareRuntimeFixture(page, selectedMode);
      fixture = await startSoakServe({
        flags,
        extraFiles: {
          'index.html': '<output id="ready">Starting</output><output id="events"></output><output id="work">Idle</output><output id="deletion">Idle</output><output id="repeat"></output><output id="healthy"></output><button id="start">Start work</button><button id="delete">Delete app</button><button id="write">Healthy write</button><script type="module" src="/main.js"></script>',
          'main.js': `
            import { initializeApp, deleteApp, getApps } from 'firebase/app';
            import { getAuth, signInAnonymously } from 'firebase/auth';
            import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
            import { getAI, getGenerativeModel } from 'firebase/ai';
            const options = { apiKey: 'demo', projectId: 'demo-hosted' };
            const app = initializeApp(options, 'closing');
            const healthy = initializeApp(options, 'healthy');
            await signInAnonymously(getAuth(app));
            await signInAnonymously(getAuth(healthy));
            const documentRef = doc(getFirestore(app), 'shared/disposal');
            await setDoc(documentRef, { message: 'Before' });
            const events = [];
            onSnapshot(documentRef, snapshot => {
              events.push(snapshot.data()?.message);
              document.querySelector('#events').textContent = JSON.stringify(events);
            }, () => {});
            document.querySelector('#start').onclick = () => {
              document.querySelector('#work').textContent = 'Pending';
              const ai = getAI(app, { engine: { kind: 'openai', baseUrl: ${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)} } });
              const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });
              model.generateContent('Finish accepted work').then(
                () => { document.querySelector('#work').textContent = 'Finished'; },
                error => { document.querySelector('#work').textContent = error.code; },
              );
            };
            document.querySelector('#delete').onclick = async () => {
              document.querySelector('#deletion').textContent = 'Deleting';
              const first = deleteApp(app);
              await deleteApp(app).then(
                () => { document.querySelector('#repeat').textContent = 'Unexpected success'; },
                error => { document.querySelector('#repeat').textContent = error.code; },
              );
              await first;
              document.querySelector('#deletion').textContent = getApps().map(app => app.name).join(',');
            };
            document.querySelector('#write').onclick = async () => {
              await setDoc(doc(getFirestore(healthy), 'shared/disposal'), { message: 'After deletion' });
              document.querySelector('#healthy').textContent = 'Written';
            };
            document.querySelector('#ready').textContent = 'Ready';
          `,
        },
      });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      await expect(page.locator('#events')).toHaveText('["Before"]');
      await page.getByRole('button', { name: 'Start work', exact: true }).click();
      await expect.poll(async () => ({ held: heldResponse !== undefined, outcome: await page.locator('#work').innerText(), errors }), {
        timeout: 5_000, message: 'SDK AI work must reach the real held upstream.',
      }).toEqual({ held: true, outcome: 'Pending', errors: [] });
      await page.getByRole('button', { name: 'Delete app', exact: true }).click();
      await expect(page.locator('#repeat')).toHaveText('app/app-deleted');
      release();
      await expect(page.locator('#work')).toHaveText('Finished');
      await expect(page.locator('#deletion')).toHaveText('healthy');
      await page.getByRole('button', { name: 'Healthy write', exact: true }).click();
      await expect(page.locator('#healthy')).toHaveText('Written');
      await expect(page.locator('#events')).toHaveText('["Before"]');
      expect(errors).toEqual([]);
    } finally {
      release();
      await page.close();
      await fixture?.stop();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
}

test('closing a remote with pending work and a listener permits natural process exit', async () => {
  test.setTimeout(20_000);
  let heldResponse: ServerResponse | undefined;
  const upstream = createServer((request, response) => {
    request.resume();
    heldResponse = response;
  });
  const fixture = await startHostedFixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('The local upstream has no address.');
    const program = `
      import { connectRemoteSandbox } from '@pyric/cli/remote';
      const remote = await connectRemoteSandbox({ url: ${JSON.stringify(fixture.info.url)} });
      remote.channel.subscribe({ target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' } },
        () => console.log('LISTENER'), error => { console.error(error); process.exitCode = 1; });
      const pending = remote.channel.op({ method: 'ai.generateContent', model: 'local',
        request: { contents: [{ role: 'user', parts: [{ text: 'Pending during disposal' }] }] },
        engine: { kind: 'openai', baseUrl: ${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)} },
      }).then(() => 'Unexpected success', error => error.code);
      process.once('message', async () => {
        remote.close();
        remote.close();
        console.log('CLOSED ' + await pending);
        process.disconnect();
      });
    `;
    const childEnvironment = { ...process.env };
    delete childEnvironment.NO_COLOR;
    const remote = spawn(process.execPath, ['--input-type=module', '--eval', program], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: childEnvironment,
    });
    child = remote;
    let stdout = '';
    let stderr = '';
    remote.stdout?.on('data', data => { stdout += data.toString(); });
    remote.stderr?.on('data', data => { stderr += data.toString(); });
    await expect.poll(() => stdout, { timeout: 5_000, message: 'Remote child must attach its listener.' }).toContain('LISTENER');
    await expect.poll(() => heldResponse !== undefined, { timeout: 5_000, message: 'Remote operation must reach the held upstream.' }).toBe(true);
    expect(remote.exitCode).toBeNull();
    remote.send('close');
    await expect.poll(() => stdout, { timeout: 5_000 }).toContain('CLOSED unavailable');
    await expect.poll(() => remote.exitCode, { timeout: 5_000, message: 'Remote must exit naturally after explicit close.' }).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.match(/LISTENER/g)).toHaveLength(1);
  } finally {
    const runningChild = child;
    const isRunning = runningChild !== undefined && runningChild.exitCode === null;
    if (isRunning) runningChild.kill('SIGKILL');
    heldResponse?.end(JSON.stringify({ error: { message: 'Fixture cleanup' } }));
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await fixture.stop();
  }
});


test('deleting an app during native worker initialization preserves accepted work without reviving the app', async ({ browser }) => {
  test.setTimeout(25_000);
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /shared/init { allow read, write: if true; } } }",
      'index.html': '<output id="ready">Starting</output><output id="work">Idle</output><output id="deleted">Idle</output><output id="apps"></output><output id="replacement"></output><output id="late"></output><button id="late-write">Write deleted app</button><button id="open">Open app</button><button id="delete">Delete app</button><button id="reopen">Reopen app</button><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp, deleteApp, getApps } from 'firebase/app';
        import { doc, getFirestore, getDoc, setDoc, increment } from 'firebase/firestore';
        const options = { apiKey: 'demo', projectId: 'demo-hosted' };
        let app;
        let documentRef;
        document.querySelector('#open').onclick = () => {
          app = initializeApp(options);
          document.querySelector('#work').textContent = 'Pending';
          documentRef = doc(getFirestore(app), 'shared/init');
          setDoc(documentRef, { count: increment(1) }).then(
            () => { document.querySelector('#work').textContent = 'Written'; },
            error => { document.querySelector('#work').textContent = error.code; },
          );
        };
        document.querySelector('#delete').onclick = async () => {
          document.querySelector('#deleted').textContent = 'Deleting';
          await deleteApp(app).then(
            () => { document.querySelector('#deleted').textContent = 'Deleted'; },
            error => { document.querySelector('#deleted').textContent = error.code; },
          );
          document.querySelector('#apps').textContent = String(getApps().length);
        };
        document.querySelector('#late-write').onclick = () => {
          setDoc(documentRef, { count: increment(1) }).then(
            () => { document.querySelector('#late').textContent = 'Unexpected write'; },
            error => { document.querySelector('#late').textContent = error.code; },
          );
        };
        document.querySelector('#reopen').onclick = async () => {
          const replacement = initializeApp(options);
          const snapshot = await getDoc(doc(getFirestore(replacement), 'shared/init'));
          document.querySelector('#replacement').textContent = JSON.stringify(snapshot.data());
          await deleteApp(replacement);
        };
        document.querySelector('#ready').textContent = 'Ready';
      `,
    },
  });
  const context = await browser.newContext();
  let owner: ReturnType<typeof startHost> | undefined;
  try {
    const firstExit = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await expect.poll(() => fixture.child.exitCode, { timeout: 5_000 }).toBe(0);
    await firstExit;
    const preload = join(fixture.dir, 'hold-worker-init.mjs');
    // SharedWorker requests do not pass through this browser-context route.
    // Hold actual server request delivery after page initialization has completed.
    writeFileSync(preload, `
      import { Server } from 'node:http';
      const emit = Server.prototype.emit;
      let initializationRequests = 0;
      let releaseInit;
      process.on('SIGUSR2', () => {
        releaseInit?.();
        releaseInit = undefined;
      });
      Server.prototype.emit = function (event, ...args) {
        const isInitialization = event === 'request' && args[0].url === '/__pyric/init.json';
        if (isInitialization) {
          initializationRequests += 1;
          process.stderr.write('Lifecycle init request ' + initializationRequests + '\\n');
          const holdsWorkerInitialization = initializationRequests === 2;
          if (holdsWorkerInitialization) {
            releaseInit = () => emit.call(this, event, ...args);
            return true;
          }
        }
        return emit.call(this, event, ...args);
      };
    `);
    owner = startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH], ['--no-capture']);
    expect(await owner.startup, owner.stderr()).toEqual({ kind: 'ready' });
    await context.addInitScript(() => {
      const NativeSharedWorker = SharedWorker;
      let observesNextPort = false;
      window.addEventListener('observe-app-port', () => { observesNextPort = true; });
      window.SharedWorker = class extends NativeSharedWorker {
        constructor(scriptURL: string | URL, options?: string | WorkerOptions) {
          super(scriptURL, options);
          const observesPort = observesNextPort;
          observesNextPort = false;
          if (observesPort) {
            let postedWrites = 0;
            const nativePost = this.port.postMessage.bind(this.port);
            this.port.postMessage = (message: unknown) => {
              const hasMethod = typeof message === 'object' && message !== null && 'method' in message;
              const isWrite = hasMethod && message.method === 'setDoc';
              if (isWrite) {
                postedWrites += 1;
                document.documentElement.dataset.appWrites = String(postedWrites);
              }
              nativePost(message);
            };
            const nativeClose = this.port.close.bind(this.port);
            this.port.close = () => {
              document.documentElement.dataset.appPort = 'closed';
              nativeClose();
            };
          }
        }
      };
    });
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await expect.poll(owner.stderr, {
      timeout: 5_000, message: 'The actual HTTP server must receive the native worker initialization after page initialization.',
    }).toContain('Lifecycle init request 2');
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
    await page.evaluate(() => window.dispatchEvent(new Event('observe-app-port')));
    await page.getByRole('button', { name: 'Open app', exact: true }).click();
    await expect(page.locator('#work')).toHaveText('Pending');
    await expect(page.locator('html')).toHaveAttribute('data-app-writes', '1');
    await page.getByRole('button', { name: 'Delete app', exact: true }).click();
    await expect(page.locator('#deleted')).toHaveText('Deleting');
    await page.clock.runFor(5_000);
    await expect(page.locator('#deleted')).toHaveText('app/delete-timeout');
    await expect(page.locator('#work')).toHaveText('app/app-deleted');
    await expect(page.locator('html')).toHaveAttribute('data-app-port', 'closed');
    await expect(page.locator('#apps')).toHaveText('0');
    owner.child.kill('SIGUSR2');
    await page.getByRole('button', { name: 'Reopen app', exact: true }).click();
    await expect(page.locator('#replacement')).toHaveText('{"count":1}');
    await page.getByRole('button', { name: 'Write deleted app', exact: true }).click();
    await expect(page.locator('#late')).toHaveText('failed-precondition');
    await expect(page.locator('html')).toHaveAttribute('data-app-writes', '1');
    await expect(page.locator('#work')).toHaveText('app/app-deleted');
    expect(errors).toEqual([]);
  } finally {
    owner?.child.kill('SIGUSR2');
    await context.close();
    await owner?.stop();
    await fixture.stop();
  }
});
