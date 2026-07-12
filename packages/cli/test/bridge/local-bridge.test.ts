/**
 * Headless local bridge (hybrid MCP, Phase 1 of design rationale).
 *
 * `createLocalBridge(sandbox)` is the in-process Bridge the headless MCP server
 * uses: `dispatch` runs the SAME tools the served bridge advertises, against a
 * Node sandbox, with no browser and no ws peer. This proves the headless tool
 * path (identical to Slice D's dispatcher, now behind the Bridge contract) and
 * that the MCP server wires up.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { sandbox as sandboxOps, getFirestore } from 'pyric/firestore';
import { createLocalBridge } from '../../src/bridge/server/local-bridge.js';
import {
  buildHeadlessMcpServer,
  saveSandboxSnapshot,
  loadSandboxSnapshot,
} from '../../src/bridge/server/headless.js';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{room}/msgs/{msg} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.uid == request.resource.data.author;
    }
  }
}`;

describe('headless local bridge (hybrid MCP, Phase 1)', () => {
  it('exposes a peerless sandbox-mode bridge with the shared tool set', () => {
    const bridge = createLocalBridge(initializeSandbox());
    expect(bridge.mode).toBe('sandbox');
    expect(bridge.isSandboxConnected()).toBe(true);
    expect(bridge.toolNames()).toEqual([...SANDBOX_TOOL_NAMES]);
  });

  it('dispatches firestore tools in-process, acting as a distinct user with rules enforced', async () => {
    const sandbox = initializeSandbox();
    sandboxOps.setRules(getFirestore(sandbox), RULES);
    const bridge = createLocalBridge(sandbox);

    // Acting as alice: her own message is allowed.
    const r1 = await bridge.dispatch('firestore_create_document', {
      path: 'rooms/r1/msgs/m1',
      data: { author: 'alice', body: 'hi' },
      as: { uid: 'alice' },
    });
    expect(r1.ok).toBe(true);

    // Acting as bob, forging a message authored by alice: rules deny it, and the
    // bridge surfaces that as ok:false (it does not reject).
    const r2 = await bridge.dispatch('firestore_create_document', {
      path: 'rooms/r1/msgs/m2',
      data: { author: 'alice', body: 'forged' },
      as: { uid: 'bob' },
    });
    expect(r2.ok).toBe(false);

    // Reading back as bob (read allowed for any signed-in user) sees alice's doc.
    const r3 = await bridge.dispatch('firestore_get_document', {
      path: 'rooms/r1/msgs/m1',
      as: { uid: 'bob' },
    });
    expect(r3.ok).toBe(true);
    expect((r3.data as { data: unknown }).data).toEqual({ author: 'alice', body: 'hi' });
  });

  it('builds an MCP server around the in-process sandbox without throwing', () => {
    const server = buildHeadlessMcpServer(initializeSandbox());
    expect(server).toBeTruthy();
  });

  it('persists and restores the sandbox snapshot across instances (Phase 1b)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-headless-'));
    try {
      // Seed a doc (admin write) and persist.
      const s1 = initializeSandbox();
      const w = await createLocalBridge(s1).dispatch('firestore_create_document', {
        path: 'rooms/r/msgs/m1',
        data: { author: 'alice', body: 'persisted' },
      });
      expect(w.ok).toBe(true);
      saveSandboxSnapshot(s1, dir);

      // A fresh sandbox restores the same data from disk.
      const s2 = initializeSandbox();
      expect(loadSandboxSnapshot(s2, dir)).toBe(1);
      const r = await createLocalBridge(s2).dispatch('firestore_get_document', {
        path: 'rooms/r/msgs/m1',
      });
      expect(r.ok).toBe(true);
      expect((r.data as { data: unknown }).data).toEqual({ author: 'alice', body: 'persisted' });

      // No file present -> null (nothing to restore).
      const empty = mkdtempSync(join(tmpdir(), 'pyric-headless-empty-'));
      expect(loadSandboxSnapshot(initializeSandbox(), empty)).toBe(null);
      rmSync(empty, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
