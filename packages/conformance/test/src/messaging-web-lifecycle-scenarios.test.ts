import { describe, expect, test } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as clientMessagingMod from 'pyric/messaging';
import { BrokerSendError, getMessagingBroker } from 'pyric/messaging/internal';
import * as swMessagingMod from 'pyric/messaging/sw';
import { initializeSandbox } from 'pyric/sandbox';
import {
  MESSAGING_WEB_SCENARIO_NAMES,
  parseSelectedMessagingWebScenarios,
  writeMessagingWebObservations,
} from '../../src/capture/messaging-web/write-observations.ts';

describe('messaging-web multi-device and token-rotation scenarios', () => {
  test('parses --only scenario filters and rejects unknown scenario names', () => {
    const all = parseSelectedMessagingWebScenarios(['--write']);
    expect([...all]).toEqual([...MESSAGING_WEB_SCENARIO_NAMES]);

    const subset = parseSelectedMessagingWebScenarios([
      '--write',
      '--only',
      'multi-device-fanout,token-rotation',
    ]);
    expect([...subset]).toEqual(['multi-device-fanout', 'token-rotation']);

    const eqSubset = parseSelectedMessagingWebScenarios([
      '--only=token-rotation',
    ]);
    expect([...eqSubset]).toEqual(['token-rotation']);

    expect(() =>
      parseSelectedMessagingWebScenarios(['--only', 'nonexistent-scenario']),
    ).toThrow(/unknown messaging-web scenario/);
  });

  test('reduces multi-device fan-out and token-rotation captures into redacted observation JSON envelopes', () => {
    const files = new Map<string, string>();
    const logs: string[] = [];
    const secretToken = 'cSecretFid0000001:APA91bSecretTokenMaterial00000000000000001';

    const written = writeMessagingWebObservations({
      obsDir: '/virtual/observations/messaging',
      projectId: 'demo-project',
      senderId: '123456789012',
      fbSdkVersion: '12.19.0',
      adminSdkVersion: '13.10.0',
      initialToken: secretToken,
      writeTokenShape: false,
      results: {
        multiDeviceFanout: {
          distinctTokensMinted: true,
          sameTokenShapeLength: true,
          tokenTargetDeliveredToDevice1: true,
          tokenTargetSilentOnDevice2: true,
          topicSubscribeSuccessCount: 2,
          topicSubscribeFailureCount: 0,
          topicSendDeliveredToDevice1: true,
          topicSendDeliveredToDevice2: true,
          multicastSuccessCount: 2,
          multicastFailureCount: 0,
          multicastDeliveredToDevice1: true,
          multicastDeliveredToDevice2: true,
          cleanupTopicUnsubscribeSuccessCount: 2,
          cleanupSecondDeviceDeletedTruthy: true,
        },
        tokenRotation: {
          clientHasOnTokenRefresh: false,
          swHasOnTokenRefresh: false,
          pushSubscriptionUnsubscribed: true,
          rotatedTokenMinted: true,
          tokenChangedOnRotation: true,
          rotatedTokenSameShapeLength: true,
          rotatedTokenDeliversForeground: true,
          firstSendToPriorTokenStatus: 404,
          priorTokenUnregistered: {
            status: 404,
            error: {
              code: 404,
              status: 'NOT_FOUND',
              message: 'Requested entity was not found.',
              details: [
                {
                  '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                  errorCode: 'UNREGISTERED',
                },
              ],
            },
          },
          noDeliveryFromPriorToken: true,
        },
      },
      log: (line) => logs.push(line),
      writeFile: (filePath, content) => {
        files.set(filePath, content);
      },
    });

    expect(written).toEqual([
      'messaging-web-multi-device-fanout',
      'messaging-web-token-rotation',
    ]);
    expect(logs).toEqual([
      'wrote messaging-web-multi-device-fanout',
      'wrote messaging-web-token-rotation',
    ]);

    const fanoutRaw = files.get(
      '/virtual/observations/messaging/messaging-web-multi-device-fanout.json',
    );
    expect(fanoutRaw).toBeDefined();
    expect(fanoutRaw?.includes(secretToken)).toBe(false);
    const fanoutJson = JSON.parse(fanoutRaw!);
    expect(fanoutJson.rowIds).toEqual(['messaging#19']);
    expect(fanoutJson.fbSdkVersion).toBe('12.19.0');
    expect(fanoutJson.adminSdkVersion).toBe('13.10.0');
    expect(fanoutJson.behavior.distinctTokensMinted).toBe(true);
    expect(fanoutJson.behavior.deduplicatedAcrossDevices).toBe(false);
    expect(fanoutJson.behavior.topicSendDeliveredToDevice1).toBe(true);
    expect(fanoutJson.behavior.topicSendDeliveredToDevice2).toBe(true);

    const rotationRaw = files.get(
      '/virtual/observations/messaging/messaging-web-token-rotation.json',
    );
    expect(rotationRaw).toBeDefined();
    expect(rotationRaw?.includes(secretToken)).toBe(false);
    const rotationJson = JSON.parse(rotationRaw!);
    expect(rotationJson.rowIds).toEqual(['messaging#20']);
    expect(rotationJson.fbSdkVersion).toBe('12.19.0');
    expect(rotationJson.adminSdkVersion).toBe('13.10.0');
    expect(rotationJson.behavior).toEqual({
      clientHasOnTokenRefresh: false,
      swHasOnTokenRefresh: false,
      pushSubscriptionUnsubscribed: true,
      rotatedTokenMinted: true,
      tokenChangedOnRotation: true,
      rotatedTokenSameShapeLength: true,
      rotatedTokenDeliversForeground: true,
      firstSendToPriorTokenStatus: 404,
      priorTokenEventuallyUnregistered: true,
      priorTokenUnregisteredHttpStatus: 404,
      priorTokenUnregisteredErrorStatus: 'NOT_FOUND',
      priorTokenFcmErrorCode: 'UNREGISTERED',
      noDeliveryFromPriorToken: true,
    });
  });

  test('pyric sandbox broker matches multi-device per-token isolation, topic/condition fan-out, and token rotation UNREGISTERED semantics', async () => {
    expect('onTokenRefresh' in clientMessagingMod).toBe(false);
    expect('onTokenRefresh' in swMessagingMod).toBe(false);

    const sandbox = initializeSandbox();
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'demo-fcm-project' },
      `msg-lifecycle-${Date.now()}`,
    );

    try {
      const broker = getMessagingBroker(sandbox);
      const tokenDevice1 = broker.getTokenFor('reg-device-1', 'recipient-device-1');
      const tokenDevice2 = broker.getTokenFor('reg-device-2', 'recipient-device-2');
      expect(tokenDevice1).not.toBe(tokenDevice2);
      expect(tokenDevice1.length).toBe(tokenDevice2.length);

      const device1Steps: string[] = [];
      const device2Steps: string[] = [];
      broker.setClientVisibility('win-device-1', 'visible', 'recipient-device-1');
      broker.setClientVisibility('win-device-2', 'visible', 'recipient-device-2');
      const unsub1 = broker.onForegroundMessage((payload) => {
        if (payload.data?.step) device1Steps.push(payload.data.step);
      }, 'recipient-device-1');
      const unsub2 = broker.onForegroundMessage((payload) => {
        if (payload.data?.step) device2Steps.push(payload.data.step);
      }, 'recipient-device-2');

      // Token-targeted send reaches device 1 only.
      broker.send({ token: tokenDevice1, data: { step: 'single-1' } });
      expect(device1Steps).toEqual(['single-1']);
      expect(device2Steps).toEqual([]);

      // Topic and condition sends fan out independently across both subscribed devices.
      const subRes = broker.subscribeToTopic([tokenDevice1, tokenDevice2], 'alerts');
      expect(subRes.successCount).toBe(2);
      broker.send({ topic: 'alerts', data: { step: 'topic-all' } });
      broker.send({ condition: "'alerts' in topics", data: { step: 'cond-all' } });
      expect(device1Steps).toEqual(['single-1', 'topic-all', 'cond-all']);
      expect(device2Steps).toEqual(['topic-all', 'cond-all']);

      // Rotate device 1's registration token: old token reports UNREGISTERED, new token delivers.
      const messaging = clientMessagingMod.getMessaging(app);
      const priorToken = await clientMessagingMod.getToken(messaging);
      expect(await clientMessagingMod.deleteToken(messaging)).toBe(true);
      const rotatedToken = await clientMessagingMod.getToken(messaging);
      expect(rotatedToken).not.toBe(priorToken);
      expect(rotatedToken.length).toBe(priorToken.length);

      let thrownPrior: unknown = null;
      try {
        broker.send({ token: priorToken, data: { step: 'stale' } });
      } catch (err) {
        thrownPrior = err;
      }
      expect(thrownPrior).toBeInstanceOf(BrokerSendError);
      expect((thrownPrior as BrokerSendError).errorCode).toBe('UNREGISTERED');
      expect((thrownPrior as BrokerSendError).envelope.status).toBe(404);

      const rotatedReceived: string[] = [];
      broker.setClientVisibility('window-default', 'visible');
      const unsubRotated = clientMessagingMod.onMessage(messaging, (payload) => {
        if (payload.data?.step) rotatedReceived.push(payload.data.step);
      });
      broker.send({ token: rotatedToken, data: { step: 'fresh-ok' } });
      expect(rotatedReceived).toEqual(['fresh-ok']);

      unsubRotated();
      unsub1();
      unsub2();
    } finally {
      await deleteApp(app).catch(() => undefined);
      sandbox.dispose();
    }
  });
});
