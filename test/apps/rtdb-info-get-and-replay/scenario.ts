// A page reads the connection state two ways and runs a transaction on a node
// with a priority, on the Node host. Production rejects a one-shot
// `get(ref(db, '.info/connected'))` with "Invalid token in path" and keeps a
// listener on it working (observation rtdb-modular-info-write-validation,
// getConnected). The installed `pyric` then replays the captured session: a
// denied transaction on a prioritized node is decided with the priority it
// keeps (rtdb-modular-priority-contract, afterTransaction), so rules that
// allow a write keeping the priority report it as now-allowed, and
// `assurance replaySession` counts a re-decided verdict as a verdict.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

interface Repro {
  signIn(): Promise<string>;
  getConnected(): Promise<{ resolved?: unknown; error?: string; code: string | null }>;
  listenConnected(): Promise<unknown>;
  writePrioritized(): Promise<void>;
  transactPrioritized(): Promise<string>;
}
declare const repro: Repro;

/** Run the installed `pyric` command from the app directory and return what it printed. */
async function pyric(app: App, args: string[]): Promise<string> {
  const { output } = await app.serverScript('pyric.mjs', args);
  return output;
}

/** Run `pyric` expecting it to fail with `code`, and return what it printed. */
async function pyricFails(app: App, args: string[], code: number): Promise<string> {
  let output: string | undefined;
  await assert.rejects(pyric(app, args), (error: Error) => {
    assert.match(error.message, new RegExp(`exited with code ${code}`), error.message);
    output = error.message;
    return true;
  });
  return output ?? '';
}

interface CapturedEvent { kind?: string; service?: string; method?: string; result?: string }

/** Wait until the host's capture holds the denied transaction. */
async function waitForDeniedTransaction(app: App): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
      const events = (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'rtdb');
      if (events.some((event) => event.method === 'transaction' && event.result === 'deny')) return;
    } catch {
      // The host has not written the capture yet.
    }
    if (Date.now() > deadline) throw new Error('.pyric/last-session.json has no denied transaction after 15s');
    await sleep(250);
  }
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page and sign in', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'repro' in window);
    await page.evaluate(() => repro.signIn());
    return page;
  });

  await app.step('a one-shot get of .info/connected rejects as production does', async () => {
    const read = await page.evaluate(() => repro.getConnected());
    assert.deepEqual(read, { error: 'Invalid token in path', code: null });
  });

  await app.step('a listener on .info/connected still delivers', async () => {
    assert.equal(await page.evaluate(() => repro.listenConnected()), true);
  });

  await app.step('the page writes a prioritized node and the rules deny a transaction on it', async () => {
    await page.evaluate(() => repro.writePrioritized());
    assert.match(await page.evaluate(() => repro.transactPrioritized()), /permission/i);
    await waitForDeniedTransaction(app);
  });

  await app.step('pyric verify under the rules the session ran with is clean', async () => {
    const output = await pyric(app, ['verify', '--service', 'rtdb']);
    assert.doesNotMatch(output, /now-allowed|now-denied/, output);
  });

  await app.step('rules that allow a write keeping the priority report the transaction as now-allowed', async () => {
    app.writeFile('keeps-priority.rules.json', JSON.stringify({
      rules: { '.read': true, t: { '.write': 'newData.getPriority() == 5' } },
    }));
    const output = await pyricFails(app, ['verify', '--service', 'rtdb', '--rules', 'rtdb=keeps-priority.rules.json'], 1);
    assert.match(output, /\[rtdb\] now-allowed: transaction \/t/, output);
  });

  await app.step('assurance replaySession counts the re-decided verdicts as verdicts', async () => {
    const candidate = JSON.stringify({ rules: { '.read': false, '.write': false } });
    const output = await pyric(app, ['assurance', 'replaySession', '--service', 'database', '--candidateRules', candidate]);
    assert.doesNotMatch(output, /changed 0 verdict/, output);
    assert.match(output, /changed [1-9]\d* verdict\(s\)/, output);
  });
});
