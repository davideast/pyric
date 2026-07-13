import { describe, expect, test } from 'bun:test';
import * as publicBridge from '../../src/bridge/server.js';
import { createBridge, type BridgeToolEvent } from '../../src/bridge/server/bridge.js';

const REMOVED_EXPORTS = [
  'createInteractiveConfirmHandler',
  'createAutoApproveHandler',
  'createDenyAllHandler',
  'createPolicyHandler',
  'hasInteractiveTTY',
  'DEFAULT_PROD_POLICIES',
  'DEFAULT_SANDBOX_POLICY',
  'FALLBACK_PROD_POLICY',
  'buildPolicyMap',
  'policyFor',
] as const;

describe('sandbox-only bridge contract', () => {
  test('public entry has no production confirmation surface', () => {
    for (const name of REMOVED_EXPORTS) {
      expect(name in publicBridge).toBe(false);
    }
  });

  test('health and forwarded audit events carry constant sandbox provenance', async () => {
    const events: BridgeToolEvent[] = [];
    const bridge = createBridge({
      project: 'contract-test',
      version: 'test',
      onToolEvent: (event) => events.push(event),
    });

    bridge.registerSandboxPeer(
      (message) => {
        if (message.type !== 'tool-call') return;
        bridge.handleSandboxMessage({
          type: 'tool-result',
          id: message.id,
          ok: true,
          result: { ok: true, summary: 'sandbox response' },
        });
      },
      ['sandbox_inspect'],
      'contract-peer',
    );

    expect('mode' in bridge).toBe(false);
    expect(bridge.health()).toMatchObject({
      mode: 'sandbox',
      project: 'contract-test',
      sandboxConnected: true,
    });
    expect(await bridge.dispatch('sandbox_inspect', {})).toMatchObject({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mode: 'sandbox',
      project: 'contract-test',
      tool: 'sandbox_inspect',
      result: { ok: true },
    });
    expect(events[0]).not.toHaveProperty('confirmation');
  });
});
