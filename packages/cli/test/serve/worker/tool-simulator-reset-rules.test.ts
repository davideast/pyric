/**
 * SharedWorker `firestore_simulator_create` + `resetAll` rules preservation
 * regression test (#1456).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import {
  allowRtdbForTransportTests,
  openStorageForTransportTests,
} from './permissive-services.js';

const ALLOW_ALL_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const DENY_ALL_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

let seq = 0;

function sendFrame(ctx: HostCtx, frame: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, {
      ...frame,
      id: `sim-reset-${++seq}`,
    } as InboundMessage);
  });
}

describe('SharedWorker firestore_simulator_create + resetAll (#1456)', () => {
  it('syncs ctx.activeRules.firestore on firestore_simulator_create so resetAll preserves the deployed rules', async () => {
    const sandbox = initializeSandbox();
    openStorageForTransportTests(sandbox, `pyric-sim-reset-${++seq}`);
    allowRtdbForTransportTests(sandbox);
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'sim-reset-test',
      subs: new Map(),
    };

    try {
      // Seed initial permissive rules through the normal host op.
      const initial = await sendFrame(ctx, {
        t: 'op',
        method: 'setRules',
        source: ALLOW_ALL_RULES,
      });
      expect(initial.ok).toBe(true);

      // Deploy stricter rules through the agent tool frame (`firestore_simulator_create`).
      const toolDeploy = await sendFrame(ctx, {
        t: 'tool',
        name: 'firestore_simulator_create',
        args: { rules: DENY_ALL_RULES },
      });
      expect(toolDeploy.ok).toBe(true);
      if (toolDeploy.ok) {
        expect((toolDeploy.value as { ok?: boolean }).ok).toBe(true);
      }
      expect(ctx.activeRules?.firestore?.source).toBe(DENY_ALL_RULES);

      // Trigger `resetAll`: the new rules installed by `firestore_simulator_create`
      // must remain enforced instead of reverting to `ALLOW_ALL_RULES`.
      const resetRes = await sendFrame(ctx, { t: 'op', method: 'resetAll' });
      expect(resetRes.ok).toBe(true);

      const postResetWrite = await sendFrame(ctx, {
        t: 'op',
        method: 'setDoc',
        path: 'notes/after-reset',
        data: { title: 'blocked' },
      });
      expect(postResetWrite.ok).toBe(false);
      if (!postResetWrite.ok) {
        expect(postResetWrite.error.code).toBe('permission-denied');
      }
    } finally {
      sandbox.dispose();
    }
  });
});
