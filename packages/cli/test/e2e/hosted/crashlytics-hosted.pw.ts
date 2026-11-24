import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cliPath, createHostedProject, startHost, type HostedProject } from './harness.js';

const APP_ID = '1:999:web:hostedchromium';

const appHtml = `<!doctype html>
<html>
  <head><title>Hosted Crashlytics Conformance</title></head>
  <body>
    <output id="status">Loading</output>
    <script type="module" src="/main.js"></script>
  </body>
</html>`;

const appJs = `
import { deleteApp, initializeApp } from 'firebase/app';
import {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from 'firebase/crashlytics';

const sharedConfig = {
  apiKey: 'fake-hosted-browser-key',
  projectId: 'hosted-smoke',
  appId: '${APP_ID}',
};

async function openBrokerInspector() {
  const ws = new WebSocket('ws://' + location.host + '/__pyric/sandbox');
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true });
    ws.addEventListener('error', (e) => rejectOpen(e), { once: true });
  });
  let acked = false;
  const waiters = new Map();
  let ackResolve = () => {};
  const ackPromise = new Promise((r) => { ackResolve = r; });

  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data));
    if (frame.type === 'attach-ack' && !acked) {
      acked = true;
      ackResolve();
      return;
    }
    if (frame.type === 'worker-res') {
      const waiter = waiters.get(frame.id);
      if (waiter) {
        waiters.delete(frame.id);
        waiter(frame);
      }
    }
  });

  ws.send(JSON.stringify({
    type: 'attach',
    protocol: 1,
    clientSessionId: 'chromium-crashlytics-inspector',
    clientInfo: { platform: 'web' },
  }));
  await ackPromise;

  let seq = 0;
  return {
    sendOp(op) {
      seq += 1;
      const id = 'insp-' + seq;
      return new Promise((resolveReply) => {
        waiters.set(id, resolveReply);
        ws.send(JSON.stringify({ type: 'worker-op', id, op }));
      });
    },
  };
}

const inspector = await openBrokerInspector();

window.__crashlyticsHosted = {
  async checkEndpointGuard() {
    const okLoopback = initializeApp(sharedConfig, 'loopback-ok');
    const c = getCrashlytics(okLoopback, { endpointUrl: 'http://127.0.0.1:4318/v1/logs' });
    const loopbackAppMatches = c.app === okLoopback;
    await deleteApp(okLoopback);
    let blockedCode = null;
    try {
      const blocked = initializeApp(sharedConfig, 'external-blocked');
      getCrashlytics(blocked, { endpointUrl: 'https://clienttelemetry.googleapis.com/v1/logs' });
    } catch (err) {
      blockedCode = err && err.code ? err.code : null;
    }
    return { loopbackAppMatches, blockedCode };
  },

  async runBrowserLifecycleScenario() {
    const app = initializeApp(sharedConfig);
    const crashlytics = getCrashlytics(app, {
      appVersion: '7.2.0',
      customAttributes: { surface: 'hosted-chromium' },
      features: [breadcrumbs()],
    });

    history.pushState({}, '', '/cart');
    window.dispatchEvent(new PopStateEvent('popstate'));
    history.pushState({}, '', '/review');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    document.dispatchEvent(new Event('visibilitychange'));

    log(crashlytics, 'clicked-submit', { items: 3 });

    const handledErr = new TypeError('caught-boundary-error');
    recordError(crashlytics, handledErr, { recovered: true });
    await flush(crashlytics);
    window.dispatchEvent(new ErrorEvent('error', {
      error: handledErr,
      message: handledErr.message,
    }));

    window.dispatchEvent(new ErrorEvent('error', {
      error: new ReferenceError('chromium-unhandled-window-error'),
      message: 'chromium-unhandled-window-error',
    }));

    const rejEvent = new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(),
      reason: new RangeError('chromium-unhandled-rejection'),
    });
    window.dispatchEvent(rejEvent);

    await flush(crashlytics);

    await inspector.sendOp({
      method: 'crashlytics.setUserId',
      appId: '${APP_ID}',
      userId: 'chromium-user-99',
    });
    await inspector.sendOp({
      method: 'crashlytics.setCustomKeys',
      appId: '${APP_ID}',
      keys: { browser: 'chromium', darkTheme: true },
    });

    await deleteApp(app);
    window.dispatchEvent(new ErrorEvent('error', {
      error: new Error('ignored-after-delete'),
      message: 'ignored-after-delete',
    }));
    log(crashlytics, 'ignored-log');
    recordError(crashlytics, new Error('ignored-explicit'));
    await flush(crashlytics);

    let freshDeletedCode = null;
    try {
      getCrashlytics(app);
    } catch (err) {
      freshDeletedCode = err && err.code ? err.code : null;
    }
    return { freshDeletedCode };
  },

  async getBrokerState() {
    const res = await inspector.sendOp({
      method: 'crashlytics.getState',
      appId: '${APP_ID}',
    });
    return res.value;
  },
};

document.getElementById('status').textContent = 'Ready';
`;

function runHostedCli(projectDir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

test.describe('HostedRuntime browser Crashlytics web conformance', () => {
  let project: HostedProject;

  test.beforeEach(() => {
    project = createHostedProject({
      'index.html': appHtml,
      'main.js': appJs,
    });
  });

  test.afterEach(() => {
    project.cleanup();
  });

  test('captures real Chromium unhandled errors, navigation/visibility breadcrumbs, endpointUrl guard, and live HostedRuntime checkpoint behavior with zero external egress', async ({
    page,
  }) => {
    const host = startHost(project.dir);
    const externalRequests: string[] = [];

    page.on('request', (req) => {
      const parsed = new URL(req.url());
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        externalRequests.push(req.url());
      }
    });

    try {
      const ready = await host.startup;
      if (ready.kind === 'exit') {
        throw new Error(
          `Host exited (${ready.code}): ${ready.stderr}\n${ready.stdout}`,
        );
      }
      expect(ready.kind).toBe('ready');

      await page.goto(ready.url);
      await expect(page.locator('#status')).toHaveText('Ready');

      const guardResult = await page.evaluate(() =>
        (
          window as unknown as {
            __crashlyticsHosted: {
              checkEndpointGuard(): Promise<{ loopbackAppMatches: boolean; blockedCode: string | null }>;
            };
          }
        ).__crashlyticsHosted.checkEndpointGuard(),
      );
      expect(guardResult).toEqual({
        loopbackAppMatches: true,
        blockedCode: 'crashlytics/invalid-endpoint',
      });

      const lifecycleResult = await page.evaluate(() =>
        (
          window as unknown as {
            __crashlyticsHosted: {
              runBrowserLifecycleScenario(): Promise<{ freshDeletedCode: string | null }>;
            };
          }
        ).__crashlyticsHosted.runBrowserLifecycleScenario(),
      );
      expect(lifecycleResult.freshDeletedCode).toBe('app/app-deleted');

      const stateBeforeCheckpoint = await page.evaluate(() =>
        (
          window as unknown as {
            __crashlyticsHosted: {
              getBrokerState(): Promise<{
                userId: string | null;
                customKeys: Record<string, unknown>;
                reports: Array<{
                  message: string;
                  fatal: boolean;
                  flushed: boolean;
                  breadcrumbs: Array<{ message: string }>;
                }>;
              }>;
            };
          }
        ).__crashlyticsHosted.getBrokerState(),
      );
      expect(stateBeforeCheckpoint.userId).toBe('chromium-user-99');
      expect(stateBeforeCheckpoint.customKeys).toEqual({
        browser: 'chromium',
        darkTheme: true,
      });
      expect(stateBeforeCheckpoint.reports.map((r) => r.message)).toEqual([
        'caught-boundary-error',
        'chromium-unhandled-window-error',
        'chromium-unhandled-rejection',
      ]);
      expect(stateBeforeCheckpoint.reports[0]?.fatal).toBe(false);
      expect(stateBeforeCheckpoint.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual([
        'navigation:/cart',
        'navigation:/review',
        'visibility:visible',
        'clicked-submit',
      ]);
      expect(stateBeforeCheckpoint.reports[1]?.fatal).toBe(true);
      expect(stateBeforeCheckpoint.reports[2]?.fatal).toBe(true);

      const cpSave = runHostedCli(project.dir, [
        'sandbox',
        'checkpoint',
        '--name',
        'browser-cp',
        '--json',
      ]);
      expect(cpSave.status, `${cpSave.stderr}\n${cpSave.stdout}`).toBe(0);

      const cpRestore = runHostedCli(project.dir, [
        'sandbox',
        'restore',
        '--name',
        'browser-cp',
        '--confirm',
        'true',
        '--json',
      ]);
      expect(cpRestore.status, `${cpRestore.stderr}\n${cpRestore.stdout}`).toBe(0);

      const afterCheckpointRestore = await page.evaluate(() =>
        (
          window as unknown as {
            __crashlyticsHosted: {
              getBrokerState(): Promise<{ reports: unknown[]; userId: string | null }>;
            };
          }
        ).__crashlyticsHosted.getBrokerState(),
      );
      expect(afterCheckpointRestore.reports).toEqual([]);
      expect(afterCheckpointRestore.userId).toBeNull();
      expect(externalRequests).toEqual([]);
    } finally {
      await page.close();
      await host.stop();
    }
  });
});
