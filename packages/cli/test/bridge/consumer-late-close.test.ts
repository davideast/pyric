/**
 * A native client re-attaches with its clientSessionId on a new socket before
 * the bridge has processed the old socket's close. The old socket's late close
 * must not remove the re-attached session from presence or reject the new
 * socket's in-flight operations.
 */
import { describe, expect, it } from 'bun:test';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage, type WorkerResFrame } from '../../src/bridge/protocol.js';

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('consumer late close after re-attach', () => {
  it('leaves the re-attached session in presence and its in-flight operations pending', async () => {
    const bridge = createBridge({ version: 'test' });
    const peerFrames: BridgeMessage[] = [];
    bridge.registerSandboxPeer((frame) => { peerFrames.push(frame); }, [], 'tab', [WORKER_RELAY_CAPABILITY]);

    const oldFrames: BridgeMessage[] = [];
    const oldSocket = createConsumerSession(bridge, (frame) => { oldFrames.push(frame); }, 'session-1');
    oldSocket.handleMessage({ type: 'attach', protocol: 1, clientSessionId: 'session-1', clientInfo: { platform: 'swift' } });
    oldSocket.handleMessage({ type: 'worker-op', id: 'old-op', op: { method: 'getDoc', path: 'rooms/a' } } as BridgeMessage);

    const newFrames: BridgeMessage[] = [];
    const newSocket = createConsumerSession(bridge, (frame) => { newFrames.push(frame); }, 'session-1');
    newSocket.handleMessage({ type: 'attach', protocol: 1, clientSessionId: 'session-1', clientInfo: { platform: 'swift' } });
    newSocket.handleMessage({ type: 'worker-op', id: 'new-op', op: { method: 'getDoc', path: 'rooms/b' } } as BridgeMessage);
    await tick();

    // The old socket's close arrives after the re-attach.
    oldSocket.detach();
    await tick();

    expect(bridge.consumers.get('session-1')).toBeDefined();
    const newReplies = newFrames.filter((frame): frame is WorkerResFrame => frame.type === 'worker-res');
    expect(newReplies).toEqual([]);
    const oldReplies = oldFrames.filter((frame): frame is WorkerResFrame => frame.type === 'worker-res');
    expect(oldReplies.map((reply) => [reply.id, reply.error?.code])).toEqual([['old-op', 'unavailable']]);

    // The new socket's operation still settles when the sandbox answers it.
    const relayed = peerFrames.filter((frame) => frame.type === 'worker-op' && (frame.op as { path?: string }).path === 'rooms/b');
    expect(relayed).toHaveLength(1);
    const relayedId = (relayed[0] as { id: string }).id;
    bridge.handleSandboxMessage({ type: 'worker-res', id: relayedId, clientSessionId: 'session-1', ok: true, value: { exists: false } }, bridge.peerGeneration());
    await tick();
    const settled = newFrames.filter((frame): frame is WorkerResFrame => frame.type === 'worker-res');
    expect(settled.map((reply) => [reply.id, reply.ok])).toEqual([['new-op', true]]);
  });

  it('still removes a session whose only socket closes', async () => {
    const bridge = createBridge({ version: 'test' });
    bridge.registerSandboxPeer(() => {}, [], 'tab', [WORKER_RELAY_CAPABILITY]);
    const frames: BridgeMessage[] = [];
    const socket = createConsumerSession(bridge, (frame) => { frames.push(frame); }, 'session-2');
    socket.handleMessage({ type: 'attach', protocol: 1, clientSessionId: 'session-2' });
    socket.handleMessage({ type: 'worker-op', id: 'op', op: { method: 'getDoc', path: 'rooms/a' } } as BridgeMessage);
    await tick();

    socket.detach();
    await tick();

    expect(bridge.consumers.get('session-2')).toBeUndefined();
    const replies = frames.filter((frame): frame is WorkerResFrame => frame.type === 'worker-res');
    expect(replies.map((reply) => [reply.id, reply.error?.code])).toEqual([['op', 'unavailable']]);
  });
});
