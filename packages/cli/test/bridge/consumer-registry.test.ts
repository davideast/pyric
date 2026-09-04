import { describe, expect, it } from 'bun:test';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import { createConsumerRegistry } from '../../src/bridge/server/consumer-registry.js';
import type { BridgeMessage, ConsumerPresenceFrame, WorkerEventFrame } from '../../src/bridge/protocol.js';

describe('ConsumerRegistry', () => {
  it('registers, touches, sets lens, and unregisters consumers', () => {
    const registry = createConsumerRegistry();
    const sentFrames: BridgeMessage[] = [];

    registry.register({
      clientSessionId: 'sess-1',
      platform: 'flutter',
      deviceLabel: 'iPhone 17 Pro',
      connectedAt: 1000,
      lastSeen: 1000,
      activeLens: { mode: 'app-session' },
      send: (msg) => sentFrames.push(msg),
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toEqual({
      clientSessionId: 'sess-1',
      platform: 'flutter',
      deviceLabel: 'iPhone 17 Pro',
      connectedAt: 1000,
      lastSeen: 1000,
      activeLens: { mode: 'app-session' },
    });

    // Touch updates lastSeen
    registry.touch('sess-1');
    expect(registry.get('sess-1')?.lastSeen).toBeGreaterThanOrEqual(1000);

    // Set lens sends worker-event to consumer
    const ok = registry.setLens('sess-1', { mode: 'as', uid: 'alice' });
    expect(ok).toBe(true);
    expect(sentFrames).toHaveLength(1);
    const event = sentFrames[0] as WorkerEventFrame;
    expect(event.type).toBe('worker-event');
    expect(event.event).toBe('remote-lens');
    expect(event.lens).toEqual({ mode: 'as', uid: 'alice' });
    expect(registry.get('sess-1')?.activeLens).toEqual({ mode: 'as', uid: 'alice' });

    // Unregister
    const removed = registry.unregister('sess-1');
    expect(removed?.clientSessionId).toBe('sess-1');
    expect(registry.list()).toHaveLength(0);
    expect(registry.setLens('sess-1', { mode: 'admin' })).toBe(false);
  });

  it('broadcasts presence to browser peer and Studio consumers', () => {
    const registry = createConsumerRegistry();
    const peerFrames: BridgeMessage[] = [];
    const studioFrames: BridgeMessage[] = [];
    const mobileFrames: BridgeMessage[] = [];

    registry.register({
      clientSessionId: 'mobile-1',
      platform: 'kotlin',
      deviceLabel: 'Pixel 8',
      connectedAt: 1000,
      lastSeen: 1000,
      activeLens: { mode: 'app-session' },
      send: (msg) => mobileFrames.push(msg),
    });

    registry.register({
      clientSessionId: 'studio-1',
      platform: 'studio',
      deviceLabel: 'Desktop Studio',
      connectedAt: 1100,
      lastSeen: 1100,
      activeLens: { mode: 'app-session' },
      send: (msg) => studioFrames.push(msg),
    });

    registry.broadcastPresence((msg) => peerFrames.push(msg));

    expect(peerFrames).toHaveLength(1);
    const peerPresence = peerFrames[0] as ConsumerPresenceFrame;
    expect(peerPresence.type).toBe('consumer-presence');
    expect(peerPresence.consumers).toHaveLength(2);

    expect(studioFrames).toHaveLength(1);
    const studioPresence = studioFrames[0] as ConsumerPresenceFrame;
    expect(studioPresence.type).toBe('consumer-presence');
    expect(studioPresence.consumers).toHaveLength(2);

    // Mobile consumer does NOT receive presence broadcast spam
    expect(mobileFrames).toHaveLength(0);
  });
});

describe('Bridge & Peer Remote Control Integration', () => {
  it('handles attach with clientInfo, presence broadcast, and remote-set-lens routing', () => {
    const bridge = createBridge({ version: '1.0.0' });
    const mobileFrames: BridgeMessage[] = [];
    const studioFrames: BridgeMessage[] = [];
    const peerFrames: BridgeMessage[] = [];

    // 1. Sandbox peer registers
    bridge.registerSandboxPeer(
      (msg) => peerFrames.push(msg),
      ['test_tool'],
      'sandbox-1',
      ['worker-relay'],
    );
    bridge.broadcastConsumerPresence();

    // Initial presence sent to peer
    expect(peerFrames).toHaveLength(1);
    expect(peerFrames[0].type).toBe('consumer-presence');

    // 2. Mobile consumer attaches
    const mobileSession = createConsumerSession(bridge, (msg) => mobileFrames.push(msg));
    mobileSession.handleMessage({
      type: 'attach',
      protocol: 1,
      clientSessionId: 'mobile-sess-1',
      clientInfo: {
        platform: 'flutter',
        deviceLabel: 'iOS Simulator',
      },
    });

    // Mobile receives attach-ack
    expect(mobileFrames.some((f) => f.type === 'attach-ack')).toBe(true);

    // Peer received updated presence
    const latestPeerPresence = peerFrames[peerFrames.length - 1] as ConsumerPresenceFrame;
    expect(latestPeerPresence.type).toBe('consumer-presence');
    expect(latestPeerPresence.consumers.some((c) => c.clientSessionId === 'mobile-sess-1')).toBe(true);

    // 3. Studio attaches as a consumer
    const studioSession = createConsumerSession(bridge, (msg) => studioFrames.push(msg));
    studioSession.handleMessage({
      type: 'attach',
      protocol: 1,
      clientSessionId: 'studio-sess-1',
      clientInfo: {
        platform: 'studio',
        deviceLabel: 'Studio Tab',
      },
    });

    // Studio receives presence broadcast
    const latestStudioPresence = studioFrames[studioFrames.length - 1] as ConsumerPresenceFrame;
    expect(latestStudioPresence.type).toBe('consumer-presence');
    expect(latestStudioPresence.consumers).toHaveLength(2);

    // 4. Studio sends remote-set-lens targeting mobile consumer
    studioSession.handleMessage({
      type: 'remote-set-lens',
      id: 'lens-op-1',
      clientSessionId: 'mobile-sess-1',
      lens: { mode: 'as', uid: 'user_456' },
    });

    // Studio gets ack
    const ack = studioFrames.find((f) => f.type === 'remote-set-lens-ack') as any;
    expect(ack).toBeDefined();
    expect(ack.ok).toBe(true);
    expect(ack.id).toBe('lens-op-1');

    // Mobile consumer received worker-event remote-lens!
    const remoteLensEvent = mobileFrames.find(
      (f) => f.type === 'worker-event' && (f as any).event === 'remote-lens',
    ) as any;
    expect(remoteLensEvent).toBeDefined();
    expect(remoteLensEvent.lens).toEqual({ mode: 'as', uid: 'user_456' });

    // 5. Mobile consumer disconnects
    mobileSession.dispose();

    // Studio receives updated presence with mobile consumer removed
    const afterDisconnectPresence = studioFrames[studioFrames.length - 1] as ConsumerPresenceFrame;
    expect(afterDisconnectPresence.type).toBe('consumer-presence');
    expect(afterDisconnectPresence.consumers.some((c) => c.clientSessionId === 'mobile-sess-1')).toBe(false);
  });
});
