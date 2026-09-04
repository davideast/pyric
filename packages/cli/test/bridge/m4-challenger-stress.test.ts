import { describe, expect, it } from 'bun:test';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import { createConsumerRegistry } from '../../src/bridge/server/consumer-registry.js';
import type {
  BridgeMessage,
  ConsumerPresenceFrame,
  RemoteSetLensAckFrame,
  WorkerEventFrame,
  AuthLens,
} from '../../src/bridge/protocol.js';

describe('Milestone M4 Challenger 2 Adversarial Stress Suite', () => {
  describe('Bridge Remote-Set-Lens Resiliency & Session Protection', () => {
    it('gracefully rejects invalid, empty, or unknown clientSessionId without crashing', () => {
      const bridge = createBridge({ version: '1.0.0' });
      const studioFrames: BridgeMessage[] = [];
      const mobileFrames: BridgeMessage[] = [];

      // Valid mobile consumer attached
      const mobileSession = createConsumerSession(bridge, (msg) => mobileFrames.push(msg));
      mobileSession.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'legit-mobile-client',
        clientInfo: { platform: 'flutter' },
      });

      // Studio attached
      const studioSession = createConsumerSession(bridge, (msg) => studioFrames.push(msg));
      studioSession.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'studio-client-1',
        clientInfo: { platform: 'studio' },
      });

      // Adversarial test cases for clientSessionId
      const maliciousIds = [
        'non-existent-session-id',
        '',
        '../../system/hacked',
        '__proto__',
        'constructor',
        'undefined',
        'null',
        ' '.repeat(100),
        'x'.repeat(10_000),
        // @ts-expect-error test non-string type resilience
        null,
        // @ts-expect-error test non-string type resilience
        undefined,
        // @ts-expect-error test object injection
        { nested: 'injection' },
      ];

      for (let i = 0; i < maliciousIds.length; i++) {
        const targetId = maliciousIds[i];
        const opId = `bad-id-${i}`;

        expect(() => {
          studioSession.handleMessage({
            type: 'remote-set-lens',
            id: opId,
            clientSessionId: targetId as any,
            lens: { mode: 'admin' },
          });
        }).not.toThrow();

        const ack = studioFrames.find((f) => f.type === 'remote-set-lens-ack' && (f as any).id === opId) as RemoteSetLensAckFrame;
        expect(ack).toBeDefined();
        expect(ack.ok).toBe(false);
        expect(ack.error).toBeDefined();
        expect(ack.error?.code).toBe('not-found');
      }

      // Verify legitimate mobile client was NEVER impacted or hijacked
      expect(mobileFrames.filter((f) => f.type === 'worker-event')).toHaveLength(0);
      expect(bridge.consumers.get('legit-mobile-client')?.activeLens).toEqual({ mode: 'app-session' });

      // Bridge health is still OK
      expect(bridge.health().status).toBe('ok');
    });

    it('handles remote-set-lens when target consumer WebSocket throws or has closed', () => {
      const bridge = createBridge({ version: '1.0.0' });
      const studioFrames: BridgeMessage[] = [];

      let shouldThrowOnSend = false;
      const dyingMobileSession = createConsumerSession(bridge, (msg) => {
        if (shouldThrowOnSend) {
          throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
        }
      });

      dyingMobileSession.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'dying-consumer-1',
        clientInfo: { platform: 'kotlin' },
      });

      const studioSession = createConsumerSession(bridge, (msg) => studioFrames.push(msg));
      studioSession.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'studio-client-2',
        clientInfo: { platform: 'studio' },
      });

      // Induce socket failure
      shouldThrowOnSend = true;

      // Studio attempts remote-set-lens on the dying consumer
      expect(() => {
        studioSession.handleMessage({
          type: 'remote-set-lens',
          id: 'dying-op-1',
          clientSessionId: 'dying-consumer-1',
          lens: { mode: 'admin' },
        });
      }).not.toThrow();

      // Disposing dying session also does not crash or throw unhandled rejection
      expect(() => {
        dyingMobileSession.dispose();
      }).not.toThrow();

      // Subsequent call to now-unregistered consumer returns not-found
      studioSession.handleMessage({
        type: 'remote-set-lens',
        id: 'dying-op-2',
        clientSessionId: 'dying-consumer-1',
        lens: { mode: 'anon' },
      });

      const ack2 = studioFrames.find((f) => f.type === 'remote-set-lens-ack' && (f as any).id === 'dying-op-2') as RemoteSetLensAckFrame;
      expect(ack2).toBeDefined();
      expect(ack2.ok).toBe(false);
      expect(ack2.error?.code).toBe('not-found');
    });

    it('survives bursts of rapid concurrent remote-set-lens and presence broadcasts', () => {
      const bridge = createBridge({ version: '1.0.0' });
      const studioFrames: BridgeMessage[] = [];
      const mobile1Frames: BridgeMessage[] = [];
      const mobile2Frames: BridgeMessage[] = [];

      const m1 = createConsumerSession(bridge, (msg) => mobile1Frames.push(msg));
      m1.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'mobile-m1',
        clientInfo: { platform: 'swift' },
      });

      const m2 = createConsumerSession(bridge, (msg) => mobile2Frames.push(msg));
      m2.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'mobile-m2',
        clientInfo: { platform: 'flutter' },
      });

      const studio = createConsumerSession(bridge, (msg) => studioFrames.push(msg));
      studio.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'studio-burst',
        clientInfo: { platform: 'studio' },
      });

      // Fire 100 rapid interleaved remote-set-lens operations across m1 and m2
      for (let i = 0; i < 100; i++) {
        const target = i % 2 === 0 ? 'mobile-m1' : 'mobile-m2';
        const lens: AuthLens =
          i % 3 === 0
            ? { mode: 'admin' }
            : i % 3 === 1
            ? { mode: 'anon' }
            : { mode: 'as', uid: `user-${i}`, token: { role: 'tester' } };

        studio.handleMessage({
          type: 'remote-set-lens',
          id: `burst-op-${i}`,
          clientSessionId: target,
          lens,
        });
      }

      // Check results
      const acks = studioFrames.filter((f) => f.type === 'remote-set-lens-ack');
      expect(acks).toHaveLength(100);
      expect(acks.every((a: any) => a.ok === true)).toBe(true);

      const m1Events = mobile1Frames.filter((f) => f.type === 'worker-event');
      const m2Events = mobile2Frames.filter((f) => f.type === 'worker-event');
      expect(m1Events).toHaveLength(50);
      expect(m2Events).toHaveLength(50);

      // Verify that M1 and M2 did not cross-pollute:
      // Last op for m1 was i=98 (98 % 3 = 2 => as user-98)
      // Last op for m2 was i=99 (99 % 3 = 0 => admin)
      expect(bridge.consumers.get('mobile-m1')?.activeLens).toEqual({
        mode: 'as',
        uid: 'user-98',
        token: { role: 'tester' },
      });
      expect(bridge.consumers.get('mobile-m2')?.activeLens).toEqual({ mode: 'admin' });
    });
  });

  describe('CEL Denial Context Wire Relay Integrity', () => {
    it('relays complex and unexpected denialContext structures across the bridge', async () => {
      const bridge = createBridge({ version: '1.0.0', callTimeoutMs: 1000 });
      let peerSendMsg: BridgeMessage | null = null;

      bridge.registerSandboxPeer(
        (msg) => {
          peerSendMsg = msg;
        },
        ['test_tool'],
        'sandbox-peer-1',
        ['worker-relay'],
      );

      // Dispatch a worker op that will be rejected with corrupted/unexpected denialContext
      const promise = bridge.dispatchWorkerOp(
        { method: 'docGet', path: 'secrets/restricted' },
        'session-test',
      );

      expect(peerSendMsg).toBeDefined();
      const opFrame = peerSendMsg as any;
      expect(opFrame.type).toBe('worker-op');

      const bizarreDenialContext = {
        rule: {
          file: 'weird_path/rules.cel',
          line: -999,
          col: 0,
          citation: 'custom:citation',
          nestedExtra: { deeply: { nested: true } },
        },
        reasons: ['Reason 1', null, 12345, { obj: 'weird' }],
        strangeKey: [true, false, null],
      };

      bridge.handleSandboxMessage({
        type: 'worker-res',
        id: opFrame.id,
        ok: false,
        error: {
          code: 'permission-denied',
          message: 'Evaluation failed',
          denialContext: bizarreDenialContext,
        },
      });

      let caughtErr: any;
      try {
        await promise;
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr.code).toBe('permission-denied');
      expect(caughtErr.denialContext).toEqual(bizarreDenialContext);
    });
  });
});
