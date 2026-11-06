/**
 * On a live host, a service read reaches a connected tab of the app through
 * the bridge's tab tools (`hosted/live-reads.ts`). A tab announces the reads
 * it answers; with no such tab the read is refused with live mode's code and
 * never answered from the sandbox. Rules tooling stays local, and a sandbox
 * host answers every read from its sandbox.
 */
import { describe, expect, it } from 'bun:test';
import type { BridgeMessage, ToolCallRequest } from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { isLiveTabRead, runHostedMethod } from '../../src/serve/hosted/live-reads.js';

const SANDBOX_ANSWER = { ok: true, summary: 'answered from the sandbox' };

function newBridge() {
  return createBridge({ version: 'test', logger: createSilentLogger() });
}

function call(key: string, args: Record<string, unknown> = {}) {
  return { instanceId: 'i', projectDir: '/p', key, args, allowProduction: false };
}

/** A tab that answers every call it receives with the tool name it was asked. */
function fakeTab(bridge: ReturnType<typeof newBridge>, tools: string[]) {
  const received: ToolCallRequest[] = [];
  const disconnect = bridge.tabTools.register((frame: BridgeMessage) => {
    const isCall = frame.type === 'tool-call';
    if (!isCall) return;
    received.push(frame);
    queueMicrotask(() => bridge.tabTools.receive({
      type: 'tool-result',
      id: frame.id,
      ok: true,
      result: { ok: true, summary: `tab answered ${frame.name}`, data: { args: frame.args } },
    }));
  }, tools);
  return { received, disconnect };
}

describe('live host reads', () => {
  it('sends a read to the connected tab that announced it', async () => {
    const bridge = newBridge();
    const tab = fakeTab(bridge, ['firestore.getDoc']);
    let ranLocally = false;
    const result = await runHostedMethod(bridge.tabTools, call('firestore.getDoc', { path: 'rooms/a' }), async () => {
      ranLocally = true;
      return SANDBOX_ANSWER;
    });
    expect(result).toEqual({ ok: true, summary: 'tab answered firestore.getDoc', data: { args: { path: 'rooms/a' } } });
    expect(tab.received.map((frame) => frame.name)).toEqual(['firestore.getDoc']);
    expect(ranLocally).toBe(false);
  });

  it('refuses a read no connected tab handles, and never answers from the sandbox', async () => {
    const bridge = newBridge();
    fakeTab(bridge, ['firestore.getDoc']);
    for (const key of ['database.get', 'storage.listAll', 'firestore.getDocs']) {
      const result = await runHostedMethod(bridge.tabTools, call(key), async () => SANDBOX_ANSWER);
      expect(result.ok).toBe(false);
      expect(result.data).toEqual({ code: 'PYRIC_LIVE_REFUSED' });
      expect(result.summary).toContain('Open the app');
    }
  });

  it('refuses once the tab that handled the read disconnects', async () => {
    const bridge = newBridge();
    const tab = fakeTab(bridge, ['database.get']);
    tab.disconnect();
    const result = await runHostedMethod(bridge.tabTools, call('database.get'), async () => SANDBOX_ANSWER);
    expect(result.data).toEqual({ code: 'PYRIC_LIVE_REFUSED' });
  });

  it('keeps rules tooling and writes on their own path', async () => {
    const bridge = newBridge();
    for (const key of ['rules.simulate', 'rules.explainDenial', 'rules.lint', 'firestore.extractIndexes', 'firestore.setDoc', 'sandbox.events']) {
      expect(isLiveTabRead(key)).toBe(false);
      const result = await runHostedMethod(bridge.tabTools, call(key), async () => SANDBOX_ANSWER);
      expect(result).toEqual(SANDBOX_ANSWER);
    }
  });

  it('answers every read from the sandbox on a sandbox host', async () => {
    for (const key of ['firestore.getDoc', 'database.get', 'storage.listAll']) {
      const result = await runHostedMethod(undefined, call(key), async () => SANDBOX_ANSWER);
      expect(result).toEqual(SANDBOX_ANSWER);
    }
  });
});
