/**
 * On a live host, a service read reaches a connected tab of the app through
 * the bridge's tab tools (`hosted/live-reads.ts`). A tab announces the reads
 * it answers; with no such tab the read is refused with live mode's code and
 * never answered from the sandbox. Rules tooling stays local, and a sandbox
 * host answers every read from its sandbox.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BridgeMessage, ToolCallRequest } from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { buildMcpServer } from '../../src/bridge/server/mcp.js';
import { BRIDGE_FORWARDED_TOOL_NAMES, getBridgeToolSurface } from '../../src/bridge/server/mcp-contract.js';
import { tabCallRoute, runHostedMethod } from '../../src/serve/hosted/live-reads.js';

const SANDBOX_ANSWER = { ok: true, summary: 'answered from the sandbox' };

function newBridge(live = true) {
  return createBridge({ version: 'test', logger: createSilentLogger(), ...(live ? { tabRoute: tabCallRoute } : {}) });
}

/** The hosted runtime's place as the bridge's sandbox peer: it answers every call from the sandbox. */
function sandboxPeer(bridge: ReturnType<typeof newBridge>): string[] {
  const asked: string[] = [];
  bridge.registerSandboxPeer((frame: BridgeMessage) => {
    if (frame.type !== 'tool-call') return;
    asked.push(frame.name);
    queueMicrotask(() => bridge.handleSandboxMessage({ type: 'tool-result', id: frame.id, ok: true, result: SANDBOX_ANSWER }));
  }, [...BRIDGE_FORWARDED_TOOL_NAMES], 'hosted');
  return asked;
}

/** An agent on the host's `/__pyric/mcp` surface. */
async function agentOn(bridge: ReturnType<typeof newBridge>) {
  const server = buildMcpServer(bridge, getBridgeToolSurface({ projectDir: process.cwd() }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const agent = new Client({ name: 'live-reads-test', version: 'test' });
  await agent.connect(clientTransport);
  return async (name: string, args: Record<string, unknown>) => {
    const result = await agent.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return content.map((part) => part.text).join('\n');
  };
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

  it('keeps rules tooling, local logs and writes on their own path', async () => {
    const bridge = newBridge();
    const local = ['rules.simulate', 'rules.explainDenial', 'rules.lint', 'firestore.extractIndexes', 'firestore.setDoc', 'sandbox.events',
      'functions.executions', 'functions.listTriggers', 'messaging.tokens', 'messaging.deliveries'];
    for (const key of local) {
      const result = await runHostedMethod(bridge.tabTools, call(key), async () => SANDBOX_ANSWER);
      expect(result).toEqual(SANDBOX_ANSWER);
    }
  });

  it('refuses a custom token, which needs a credential pyric does not hold, even with a tab', async () => {
    const bridge = newBridge();
    const tab = fakeTab(bridge, ['auth.createCustomToken']);
    const result = await runHostedMethod(bridge.tabTools, call('auth.createCustomToken', { uid: 'a' }), async () => SANDBOX_ANSWER);
    expect(result.data).toEqual({ code: 'PYRIC_LIVE_REFUSED' });
    expect(tab.received).toEqual([]);
  });

  it('routes a forwarded read on /__pyric/mcp to the tab, and refuses it with none', async () => {
    const bridge = newBridge();
    const asked = sandboxPeer(bridge);
    const callTool = await agentOn(bridge);
    const refused = await callTool('firestore_get_document', { path: 'rooms/a' });
    expect(refused).toContain('PYRIC_LIVE_REFUSED');
    expect(refused).not.toContain(SANDBOX_ANSWER.summary);
    const tab = fakeTab(bridge, ['firestore_get_document', 'rtdb_crawl_structure']);
    const routed = await callTool('firestore_get_document', { path: 'rooms/a' });
    expect(routed).toContain('tab answered firestore_get_document');
    expect(await callTool('firestore_list_documents', { collection: 'rooms' })).toContain('PYRIC_LIVE_REFUSED');
    expect(tab.received.map((frame) => frame.name)).toEqual(['firestore_get_document']);
    expect(asked).toEqual([]);
  });

  it('answers forwarded reads on /__pyric/mcp from the sandbox on a sandbox host', async () => {
    const bridge = newBridge(false);
    const asked = sandboxPeer(bridge);
    const callTool = await agentOn(bridge);
    expect(await callTool('firestore_get_document', { path: 'rooms/a' })).toContain(SANDBOX_ANSWER.summary);
    expect(asked).toEqual(['firestore_get_document']);
  });

  it('answers every read from the sandbox on a sandbox host', async () => {
    for (const key of ['firestore.getDoc', 'database.get', 'storage.listAll']) {
      const result = await runHostedMethod(undefined, call(key), async () => SANDBOX_ANSWER);
      expect(result).toEqual(SANDBOX_ANSWER);
    }
  });
});
