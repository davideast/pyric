import { afterEach, describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getMessaging as getUpstreamMessaging, type Message } from 'firebase-admin/messaging';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';

import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  FirebaseMessagingError,
  getMessaging,
  type Messaging,
} from '../../src/messaging/index.js';

const SERVE_URL = 'http://localhost:5000';

interface MessagingArm {
  readonly label: 'local' | 'remote';
  create(): {
    svc: Messaging;
    cleanup: () => Promise<void>;
  };
}

function connectWorkerTab(bridge: Bridge, ctx: HostCtx): void {
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        if (m.ok) {
          bridge.handleSandboxMessage({ type: 'worker-res', id: m.id, ok: true, value: m.value }, gen);
        } else {
          bridge.handleSandboxMessage({ type: 'worker-res', id: m.id, ok: false, error: m.error }, gen);
        }
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage({ type: 'worker-snap', subId: m.subId, value: m.value }, gen);
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    if (msg.type === 'worker-op') {
      void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id } as InboundMessage);
    } else if (msg.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId } as InboundMessage);
    } else if (msg.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'config-parity-tab', [WORKER_RELAY_CAPABILITY]);
}

function connectRemoteSandbox(bridge: Bridge): RemoteSandbox {
  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(msg));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(msg) },
    { serveUrl: SERVE_URL },
  );
  handleMsg = core.handleMessage;
  core.start();
  return createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('closed by test'),
  });
}

const ARMS: readonly MessagingArm[] = [
  {
    label: 'local',
    create() {
      const sandbox = initializeSandbox({ projectId: 'demo-project' });
      const app = initializeApp(
        { sandbox, projectId: 'demo-project' },
        `cfg-local-${Math.random().toString(36).slice(2)}`,
      );
      return {
        svc: getMessaging(app),
        async cleanup() {
          await deleteApp(app).catch(() => {});
          sandbox.dispose();
        },
      };
    },
  },
  {
    label: 'remote',
    create() {
      const sandbox = initializeSandbox({ projectId: 'demo-project' });
      const ctx: HostCtx = {
        db: getFirestore(sandbox),
        sandbox,
        instanceId: 'cfg-remote',
        subs: new Map(),
        messagingEnabled: true,
      };
      const bridge = createBridge({ mode: 'sandbox', version: 'test' });
      connectWorkerTab(bridge, ctx);
      const remote = connectRemoteSandbox(bridge);
      const app = initializeApp(
        { sandbox: remote, projectId: 'demo-project' },
        `cfg-remote-${Math.random().toString(36).slice(2)}`,
      );
      return {
        svc: getMessaging(app),
        async cleanup() {
          await deleteApp(app).catch(() => {});
          remote.dispose();
          sandbox.dispose();
        },
      };
    },
  },
];

async function captureError(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && 'message' in err) {
      return {
        code: String(err.code),
        message: String(err.message),
      };
    }
    throw err;
  }
  return { code: 'resolved', message: '' };
}

function freshUpstream() {
  const app = initializeUpstreamApp(
    { projectId: 'demo-project' },
    `upstream-cfg-${Math.random().toString(36).slice(2)}`,
  );
  return getUpstreamMessaging(app);
}

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app).catch(() => {});
  for (const app of getUpstreamApps()) await deleteUpstreamApp(app).catch(() => {});
});

const INVALID_CONFIG_CASES: ReadonlyArray<{ label: string; message: Record<string, unknown> }> = [
  {
    label: 'duplicate Aps contentAvailable + content-available',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { contentAvailable: true, 'content-available': 1 } } },
    },
  },
  {
    label: 'ApsAlert locArgs without locKey',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { alert: { locArgs: ['arg1'] } } } },
    },
  },
  {
    label: 'ApsAlert titleLocArgs without titleLocKey',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { alert: { titleLocArgs: ['targ1'] } } } },
    },
  },
  {
    label: 'ApsAlert subtitleLocArgs without subtitleLocKey',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { alert: { subtitleLocArgs: ['sarg1'] } } } },
    },
  },
  {
    label: 'CriticalSound empty name',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { sound: { name: '' } } } },
    },
  },
  {
    label: 'CriticalSound negative volume',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { sound: { name: 'default', volume: -0.1 } } } },
    },
  },
  {
    label: 'CriticalSound volume > 1',
    message: {
      topic: 'alerts',
      apns: { payload: { aps: { sound: { name: 'default', volume: 1.5 } } } },
    },
  },
  {
    label: 'AndroidNotification bodyLocArgs without bodyLocKey',
    message: {
      topic: 'alerts',
      android: { notification: { bodyLocArgs: ['arg1'] } },
    },
  },
  {
    label: 'AndroidNotification non-Date eventTimestamp',
    message: {
      topic: 'alerts',
      android: { notification: { eventTimestamp: '2026-01-01T00:00:00Z' } },
    },
  },
  {
    label: 'LightSettings negative lightOnDurationMillis',
    message: {
      topic: 'alerts',
      android: {
        notification: {
          lightSettings: { color: '#AABBCC', lightOnDurationMillis: -1, lightOffDurationMillis: 400 },
        },
      },
    },
  },
  {
    label: 'LightSettings malformed short hex color',
    message: {
      topic: 'alerts',
      android: {
        notification: {
          lightSettings: { color: '#123', lightOnDurationMillis: 200, lightOffDurationMillis: 400 },
        },
      },
    },
  },
];

for (const arm of ARMS) {
  describe(`pyric-admin/messaging config option validation parity [${arm.label}]`, () => {
    it('matches firebase-admin/messaging code and message on APNs and Android preflight rejections', async () => {
      const upstream = freshUpstream();
      const { svc, cleanup } = arm.create();
      try {
        for (const testCase of INVALID_CONFIG_CASES) {
          const upstreamErr = await captureError(() =>
            upstream.send(structuredClone(testCase.message) as unknown as Message, true),
          );
          expect(upstreamErr.code).toBe('messaging/invalid-payload');

          const pyricDryErr = await captureError(() =>
            svc.send(structuredClone(testCase.message) as unknown as Message, true),
          );
          expect(pyricDryErr).toEqual(upstreamErr);

          const batchRes = await svc.sendEach(
            [structuredClone(testCase.message) as unknown as Message],
            true,
          );
          expect(batchRes.failureCount).toBe(1);
          expect(batchRes.responses[0]?.error).toBeInstanceOf(FirebaseMessagingError);
          expect(batchRes.responses[0]?.error?.code).toBe(upstreamErr.code);
          expect(batchRes.responses[0]?.error?.message).toBe(upstreamErr.message);
        }
      } finally {
        await cleanup();
      }
    });

    it('accepts valid APNs ApsAlert, CriticalSound, AndroidNotification Date/vibrate, and 6/8-digit LightSettings', async () => {
      const { svc, cleanup } = arm.create();
      try {
        const apnsId = await svc.send(
          {
            topic: 'alerts',
            apns: {
              headers: { 'apns-priority': '10' },
              payload: {
                aps: {
                  alert: {
                    title: 'Title',
                    locKey: 'BODY_LOC',
                    locArgs: ['a1'],
                    titleLocKey: 'TITLE_LOC',
                    titleLocArgs: ['t1'],
                    subtitleLocKey: 'SUB_LOC',
                    subtitleLocArgs: ['s1'],
                  },
                  sound: { critical: true, name: 'default', volume: 0.5 },
                  contentAvailable: true,
                  mutableContent: true,
                  threadId: 'thread-1',
                },
                itemId: 'item-1',
              },
              fcmOptions: {
                analyticsLabel: 'ios_promo',
                imageUrl: 'https://example.com/banner.png',
              },
            },
          },
          true,
        );
        expect(apnsId).toMatch(/^projects\/demo-project\/messages\/[^/]+$/);

        const androidId = await svc.send(
          {
            topic: 'alerts',
            android: {
              collapseKey: 'col-a',
              priority: 'high',
              ttl: 3600000,
              data: { item: '1' },
              notification: {
                title: 'Alert',
                color: '#112233',
                eventTimestamp: new Date('2026-01-01T00:00:00.000Z'),
                vibrateTimingsMillis: [100, 250],
                bodyLocKey: 'BODY_KEY',
                bodyLocArgs: ['arg1'],
                lightSettings: {
                  color: '#AABBCC80',
                  lightOnDurationMillis: 150,
                  lightOffDurationMillis: 300,
                },
              },
              fcmOptions: { analyticsLabel: 'android_promo' },
            },
          },
          true,
        );
        expect(androidId).toMatch(/^projects\/demo-project\/messages\/[^/]+$/);

        // Top-level fcmOptions.analyticsLabel > 50 chars is accepted by FCM v1 wire,
        // while android.fcmOptions.analyticsLabel > 50 chars fails wire validation.
        const topLevelLong = await svc.send(
          {
            topic: 'alerts',
            fcmOptions: { analyticsLabel: 'a'.repeat(51) },
          },
          true,
        );
        expect(topLevelLong).toMatch(/^projects\/demo-project\/messages\/[^/]+$/);

        const androidAt50 = await svc.send(
          {
            topic: 'alerts',
            android: { fcmOptions: { analyticsLabel: 'a'.repeat(50) } },
          },
          true,
        );
        expect(androidAt50).toMatch(/^projects\/demo-project\/messages\/[^/]+$/);

        const oversizedAndroidLabel = 'a'.repeat(51);
        let androidErr: unknown;
        try {
          await svc.send(
            {
              topic: 'alerts',
              android: { fcmOptions: { analyticsLabel: oversizedAndroidLabel } },
            },
            true,
          );
        } catch (err) {
          androidErr = err;
        }
        expect(androidErr).toBeInstanceOf(FirebaseMessagingError);
        expect((androidErr as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
        expect((androidErr as FirebaseMessagingError).message).toBe(
          `Invalid analytics label: ${oversizedAndroidLabel}`,
        );
      } finally {
        await cleanup();
      }
    });
  });
}
