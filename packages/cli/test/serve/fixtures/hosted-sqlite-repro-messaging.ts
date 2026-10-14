import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { replayRepro } from '../../../src/serve/repro/index.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

type Res = Extract<OutboundMessage, { t: 'res' }>;

/** Record one `messaging.setVisibility` on a host started with Messaging on or off. */
async function record(directory: string, messaging: boolean) {
  mkdirSync(directory, { recursive: true });
  const payload: InitPayload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, messaging };
  const waiting = new Map<string, (response: Res) => void>();
  const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', (frame: BridgeMessage) => {
    const isReply = frame.type === 'worker-message-result' && frame.message.t === 'res';
    if (isReply) waiting.get(`${frame.clientSessionId}:${(frame.message as Res).id}`)?.(frame.message as Res);
  }, directory);
  try {
    const response = await new Promise<Res>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
      waiting.set('tab:visible', (reply) => { clearTimeout(deadline); resolve(reply); });
      const frame: InboundMessage = { t: 'op', id: 'visible', method: 'messaging.setVisibility', state: 'visible' };
      runtime.receive({ type: 'worker-message', clientSessionId: 'tab', message: frame });
    });
    return { response, repro: await runtime.captureRepro() as unknown as Record<string, unknown> };
  } finally { await runtime.close(); }
}

/** A copy of a repro as a file written before the messaging setting was recorded. */
function withoutMessagingField(repro: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(repro) as { base: Record<string, unknown> };
  delete copy.base.messaging;
  return copy;
}

const root = process.argv[2];

// A session with Messaging on records the setting, and replay enables it on both planes.
const enabled = await record(join(root, 'enabled'), true);
assert.equal(enabled.response.ok, true, JSON.stringify(enabled.response));
assert.equal((enabled.repro.base as { messaging?: unknown }).messaging, true);
const enabledReport = await replayRepro(enabled.repro);
assert.equal(enabledReport.ok, true, JSON.stringify(enabledReport, null, 2));
for (const plane of ['node', 'worker'] as const) assert.equal(enabledReport.planes[plane]?.checked, 1);

// A session with Messaging off records that, and replay keeps it off.
const disabled = await record(join(root, 'disabled'), false);
assert.equal(disabled.response.ok, false);
assert.equal((disabled.repro.base as { messaging?: unknown }).messaging, false);
const disabledReport = await replayRepro(disabled.repro);
assert.equal(disabledReport.ok, true, JSON.stringify(disabledReport, null, 2));

// A file without the field replays with Messaging off, as files written before it did.
const olderReport = await replayRepro(withoutMessagingField(disabled.repro));
assert.equal(olderReport.ok, true, JSON.stringify(olderReport, null, 2));
const olderEnabledReport = await replayRepro(withoutMessagingField(enabled.repro));
for (const plane of ['node', 'worker'] as const) {
  const first = olderEnabledReport.planes[plane]?.firstDivergence;
  assert.equal(first?.operation.method, 'messaging.setVisibility', JSON.stringify(olderEnabledReport.planes[plane]));
  assert.equal((first?.actual as { error?: { code?: string } }).error?.code, 'messaging/disabled');
}
console.log('Repro messaging passed');
