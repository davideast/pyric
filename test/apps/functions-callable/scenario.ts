// An app calling v2 onCall, streaming onCall, and v1 https.onCall functions
// through unmodified `firebase/functions` in both Chromium and a registered
// Node process against Vite `pyric({ hosted: true })`.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface BrowserFlowResult {
  uid: string;
  created: { id: string; ownerUid: string };
  stored: { title: string; ownerUid: string } | null;
  viaRun: { id: string; ownerUid: string };
  chunks: Array<{ index: number }>;
  streamResult: { sent: number };
  v1Result: { data: { ping: string }; uid: string };
  emptyRejected: {
    name: string;
    code: string;
    details: { field: string };
    hasUrl: boolean;
  } | null;
}

declare function runBrowserFlow(): Promise<BrowserFlowResult>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted Vite dev server with v2 and v1 onCall functions', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(/functions 3 onCall functions:/, { timeoutMs: 60_000 });
    return started;
  });

  const consoleWarnings: string[] = [];
  const page = await app.step('open the page in Chromium', async () => {
    const opened = await app.page(host.url);
    opened.on('console', (msg) => {
      if (msg.type() === 'warning') {
        consoleWarnings.push(msg.text());
      }
    });
    await opened.waitForFunction(() => 'runBrowserFlow' in window);
    return opened;
  });

  await app.step('the page calls v2, run.app URL, streaming, and v1 callables through firebase/functions', async () => {
    const flow = await page.evaluate(() => runBrowserFlow());
    assert.equal(flow.created.ownerUid, flow.uid);
    assert.deepEqual(flow.stored, { title: 'from browser', ownerUid: flow.uid });
    assert.equal(flow.viaRun.ownerUid, flow.uid);
    assert.deepEqual(flow.chunks, [{ index: 1 }, { index: 2 }]);
    assert.deepEqual(flow.streamResult, { sent: 2 });
    assert.deepEqual(flow.v1Result, { data: { ping: 'pong' }, uid: flow.uid });
    assert.deepEqual(flow.emptyRejected, {
      name: 'FirebaseError',
      code: 'functions/invalid-argument',
      details: { field: 'title' },
      hasUrl: true,
    });
    const emulatorWarns = consoleWarnings.filter((line) => line.includes('connectFunctionsEmulator'));
    assert.equal(emulatorWarns.length, 1, consoleWarnings.join('\n'));
  });

  await app.step('a registered Node process calls the same function and refuses off-machine URLs', async () => {
    const res = await app.serverScript('node-client.mjs', [], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
      timeoutMs: 30_000,
    });
    const match = res.output.match(/^NODE_OUTCOME (.*)$/m);
    assert.ok(match?.[1], res.output);
    const outcome = JSON.parse(match[1]) as {
      uid: string;
      created: { id: string; ownerUid: string };
      stored: { title: string; ownerUid: string } | null;
      offMachineCode: string | null;
    };
    assert.equal(outcome.created.ownerUid, outcome.uid);
    assert.deepEqual(outcome.stored, { title: 'from node script', ownerUid: outcome.uid });
    assert.equal(outcome.offMachineCode, 'functions/unavailable');
  });
});
