import { describe, expect, it } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  deleteToken,
  getMessaging,
  getToken,
  onMessage,
  onRegistered,
  onUnregistered,
  register,
  sandbox as messagingSandbox,
  unregister,
  type RegisterOptions,
} from 'pyric/messaging';
import { BrokerSendError, FID_LENGTH, FID_SHAPE_RE, getMessagingBroker } from 'pyric/messaging/internal';
import * as swMessagingMod from 'pyric/messaging/sw';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';

describe('pyric/messaging & pyric/messaging/sw registration API (#1673)', () => {
  it('enforces permission-blocked, invalid-on-registered-handler, and invalid-sw-registration preconditions in upstream order', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, { projectId: 'reg-precond' }, 'reg-precond');
    const messaging = getMessaging(app);

    // 1. Missing onRegistered handler throws messaging/invalid-on-registered-handler.
    await expect(register(messaging)).rejects.toMatchObject({
      code: 'messaging/invalid-on-registered-handler',
    });

    // 2. Notification.permission === 'denied' precedes missing onRegistered handler.
    const originalNotification = (globalThis as { Notification?: unknown }).Notification;
    (globalThis as { Notification?: unknown }).Notification = { permission: 'denied' };
    try {
      await expect(register(messaging)).rejects.toMatchObject({
        code: 'messaging/permission-blocked',
      });
    } finally {
      if (originalNotification === undefined) {
        delete (globalThis as { Notification?: unknown }).Notification;
      } else {
        (globalThis as { Notification?: unknown }).Notification = originalNotification;
      }
    }

    // 3. Invalid serviceWorkerRegistration throws messaging/invalid-sw-registration once onRegistered is set.
    onRegistered(messaging, () => {});
    const badOpts: RegisterOptions = {
      serviceWorkerRegistration: 42 as unknown as ServiceWorkerRegistration,
    };
    await expect(register(messaging, badOpts)).rejects.toMatchObject({
      code: 'messaging/invalid-sw-registration',
    });
    sandbox.dispose();
  });

  it('delivers stable 22-char FIDs per registration scope, supports topic + direct FID sends, and round-trips persistence', async () => {
    const backend = createMemoryBackend();
    const s1 = initializeSandbox();
    await s1.enablePersistence({ key: 'messaging-fid', injectedBackend: backend });
    const app1 = createAppForSandbox(s1, { projectId: 'reg-persist' }, 'reg-persist');
    const m1 = getMessaging(app1);
    const sw1 = swMessagingMod.getMessaging(app1);

    const customReg = {
      scope: '/custom-push-scope',
      active: { state: 'activated' as const },
    } as unknown as ServiceWorkerRegistration;
    const defaultSeen: string[] = [];
    const swSeen: string[] = [];
    onRegistered(m1, (fid) => defaultSeen.push(fid));
    swMessagingMod.onRegistered(sw1, (fid) => swSeen.push(fid));

    await register(m1);
    expect(defaultSeen).toHaveLength(1);
    const fidDefault = defaultSeen[0] ?? '';
    expect(fidDefault.length).toBe(FID_LENGTH);
    expect(FID_SHAPE_RE.test(fidDefault)).toBe(true);
    expect(swSeen).toEqual([fidDefault]);

    // Separate SW registration mints a distinct FID; switching back keeps the original FID.
    await register(m1, { vapidKey: 'vapid-1', serviceWorkerRegistration: customReg });
    expect(defaultSeen).toHaveLength(2);
    const fidCustom = defaultSeen[1] ?? '';
    expect(FID_SHAPE_RE.test(fidCustom)).toBe(true);
    expect(fidCustom).not.toBe(fidDefault);

    await register(m1, {
      serviceWorkerRegistration: messagingSandbox.registration() as unknown as ServiceWorkerRegistration,
    });
    expect(defaultSeen[2]).toBe(fidDefault);

    // Topic subscribe + send works with FID targets.
    const broker1 = getMessagingBroker(s1);
    const subRes = broker1.subscribeToTopic([fidDefault], 'news');
    expect(subRes).toEqual({ successCount: 1, failureCount: 0, errors: [] });

    await s1.flush();
    s1.dispose();

    // Restore onto fresh sandbox: active FID stays routable without re-registering.
    const s2 = initializeSandbox();
    await s2.enablePersistence({ key: 'messaging-fid', injectedBackend: backend });
    const app2 = createAppForSandbox(s2, { projectId: 'reg-persist' }, 'reg-persist');
    const m2 = getMessaging(app2);
    const fg: unknown[] = [];
    onMessage(m2, (payload) => fg.push(payload));
    await messagingSandbox.deliver(m2, { visibilityState: 'visible', data: { init: '1' } });
    fg.length = 0;

    const broker2 = getMessagingBroker(s2);
    broker2.send({ topic: 'news', data: { kind: 'topic' } });
    broker2.send({ token: fidDefault, data: { kind: 'direct' } });
    expect(fg).toHaveLength(2);

    s2.dispose();
  });

  it('models deleteToken vs unregister interactions faithfully with @firebase/messaging 0.13.3', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, { projectId: 'reg-del' }, 'reg-del');
    const messaging = getMessaging(app);

    const unregEvents: string[] = [];
    onRegistered(messaging, () => {});
    onUnregistered(messaging, (fid) => unregEvents.push(fid));

    // Case 1: Only legacy getToken() called -> deleteToken() revokes token WITHOUT firing onUnregistered.
    const legacyToken = await getToken(messaging);
    expect(await deleteToken(messaging)).toBe(true);
    expect(unregEvents).toEqual([]);
    expect(() => getMessagingBroker(sandbox).send({ token: legacyToken, data: { a: '1' } })).toThrow(
      BrokerSendError,
    );

    // Case 2: getToken() followed by register() clears local legacy token metadata,
    // so a subsequent deleteToken() revokes the FID registration and fires onUnregistered(fid).
    await getToken(messaging);
    const regFids: string[] = [];
    onRegistered(messaging, (fid) => regFids.push(fid));
    await register(messaging);
    const activeFid = regFids[0] ?? '';
    expect(await deleteToken(messaging)).toBe(true);
    expect(unregEvents).toEqual([activeFid]);

    // Case 3: Re-registering after unregister/deleteToken reuses the installation FID and reactivates routing.
    await register(messaging);
    expect(regFids[1]).toBe(activeFid);
    expect(() => getMessagingBroker(sandbox).send({ token: activeFid, data: { ok: '1' } })).not.toThrow();

    await unregister(messaging);
    expect(unregEvents).toEqual([activeFid, activeFid]);
    sandbox.dispose();
  });
});
