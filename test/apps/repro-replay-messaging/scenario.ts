// A page that initializes firebase/messaging reports its visibility to the
// Node host. A repro captured from that session must replay on both planes
// with Messaging on, as the live host served it, instead of answering each
// recorded `messaging.setVisibility` with `messaging/disabled` (#966).
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

const REPRO_FILE = 'bug-repro.json';

interface ReproFrame { t?: string; method?: string; id?: string; ok?: boolean }

interface ReproFileShape {
  base: { messaging?: boolean };
  entries: Array<{ kind: string; frame?: ReproFrame }>;
}

/** The host's recorded answer to the page's visibility report, once the log holds one. */
function visibilityResult(repro: ReproFileShape): ReproFrame | undefined {
  const report = repro.entries.find((entry) => entry.kind === 'in' && entry.frame?.method === 'messaging.setVisibility');
  if (report === undefined) return undefined;
  const isAnswer = (frame: ReproFrame | undefined) => frame?.t === 'res' && frame.id === report.frame?.id;
  return repro.entries.find((entry) => entry.kind === 'out' && isAnswer(entry.frame))?.frame;
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  await app.step('the page initializes firebase/messaging', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'messagingReady' in window);
  });

  await app.step('pyric serve repro capture writes the answered visibility report', async () => {
    // The visibility report is sent without awaiting; capture retries until it is logged.
    const deadline = Date.now() + 15_000;
    for (;;) {
      await app.serverScript('pyric.mjs', ['serve', 'repro', 'capture', '--out', REPRO_FILE]);
      const result = visibilityResult(JSON.parse(app.readFile(REPRO_FILE)) as ReproFileShape);
      if (result !== undefined) {
        assert.equal(result.ok, true, 'the live host refused messaging.setVisibility');
        return;
      }
      if (Date.now() > deadline) assert.fail('the repro has no answered messaging.setVisibility');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });

  await app.step('pyric serve repro replay matches the recording on the Node and worker hosts', async () => {
    const { output } = await app.serverScript('pyric.mjs', ['serve', 'repro', 'replay', REPRO_FILE]);
    assert.match(output, /^node: matches the recording/m, output);
    assert.match(output, /^worker: matches the recording/m, output);
  });

  await app.step('the repro file records that the host served Messaging', () => {
    const repro = JSON.parse(app.readFile(REPRO_FILE)) as ReproFileShape;
    assert.equal(repro.base.messaging, true);
  });
});
