import { expect } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import { BrokerSendError, FID_LENGTH, FID_SHAPE_RE, getMessagingBroker } from 'pyric/messaging/internal';
import { initializeSandbox } from 'pyric/sandbox';

export function registrationConformanceAssertions(
  loadClient: () => Promise<any>,
  loadSw: () => Promise<any>,
): Record<string, () => Promise<void> | void> {
  return {
    'messaging#22': async () => {
      const m = await loadClient();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-22' }, 'msg-reg-22');
      const messaging = m.getMessaging(app);

      // Without onRegistered, register() rejects with messaging/invalid-on-registered-handler.
      await expect(m.register(messaging)).rejects.toMatchObject({
        code: 'messaging/invalid-on-registered-handler',
      });

      const seen: string[] = [];
      const unsub = m.onRegistered(messaging, (fid: string) => {
        seen.push(fid);
      });
      const resolved = await m.register(messaging);
      expect(resolved).toBeUndefined();
      expect(seen).toHaveLength(1);
      const fid = seen[0] ?? '';
      expect(fid.length).toBe(FID_LENGTH);
      expect(FID_SHAPE_RE.test(fid)).toBe(true);

      // Calling register() again re-notifies onRegistered with the same installation FID.
      await m.register(messaging, { vapidKey: 'test-vapid-key' });
      expect(seen).toEqual([fid, fid]);

      // Send plane routes messages targeted at the registered FID.
      const fg: any[] = [];
      m.onMessage(messaging, (payload: any) => fg.push(payload));
      await m.sandbox.deliver(messaging, { visibilityState: 'visible', data: { warm: '1' } });
      fg.length = 0;
      getMessagingBroker(sandbox).send({ token: fid, data: { viaFid: 'ok' } });
      expect(fg).toHaveLength(1);
      expect(fg[0].data).toEqual({ viaFid: 'ok' });

      unsub();
      sandbox.dispose();
    },

    'messaging#23': async () => {
      const m = await loadClient();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-23' }, 'msg-reg-23');
      const messaging = m.getMessaging(app);

      let registeredFid = '';
      const unregistered: string[] = [];
      m.onRegistered(messaging, (fid: string) => {
        registeredFid = fid;
      });
      m.onUnregistered(messaging, (fid: string) => {
        unregistered.push(fid);
      });
      await m.register(messaging);
      const out = await m.unregister(messaging);
      expect(out).toBeUndefined();
      expect(unregistered).toEqual([registeredFid]);

      // Send plane rejects sends to the unregistered FID with UNREGISTERED (404).
      let caught: unknown;
      try {
        getMessagingBroker(sandbox).send({ token: registeredFid, data: { dead: '1' } });
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof BrokerSendError).toBe(true);
      expect((caught as BrokerSendError).errorCode).toBe('UNREGISTERED');
      sandbox.dispose();
    },

    'messaging#24': async () => {
      const m = await loadClient();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-24' }, 'msg-reg-24');
      const messaging = m.getMessaging(app);

      const firstCalls: string[] = [];
      const secondCalls: string[] = [];
      const unsub1 = m.onRegistered(messaging, (fid: string) => firstCalls.push(fid));
      const unsub2 = m.onRegistered(messaging, {
        next: (fid: string) => secondCalls.push(fid),
        error: () => {},
        complete: () => {},
      });
      // Stale unsubscribe from replaced listener must not clear the active observer.
      unsub1();
      await m.register(messaging);
      expect(firstCalls).toEqual([]);
      expect(secondCalls).toHaveLength(1);

      unsub2();
      await expect(m.register(messaging)).rejects.toMatchObject({
        code: 'messaging/invalid-on-registered-handler',
      });
      sandbox.dispose();
    },

    'messaging#25': async () => {
      const m = await loadClient();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-25' }, 'msg-reg-25');
      const messaging = m.getMessaging(app);

      const events: string[] = [];
      m.onRegistered(messaging, () => {});
      const unsub = m.onUnregistered(messaging, {
        next: (fid: string) => events.push(fid),
        error: () => {},
        complete: () => {},
      });
      await m.register(messaging);
      // deleteToken() when FID-registered (and no legacy token exists) revokes FID and notifies onUnregistered.
      const deleted = await m.deleteToken(messaging);
      expect(deleted).toBe(true);
      expect(events).toHaveLength(1);

      unsub();
      await m.unregister(messaging);
      expect(events).toHaveLength(1);
      sandbox.dispose();
    },

    'messaging#26': async () => {
      const m = await loadClient();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-26' }, 'msg-reg-26');
      const messaging = m.getMessaging(app);

      const seen: string[] = [];
      m.onRegistered(messaging, (fid: string) => seen.push(fid));
      await m.register(messaging, {
        vapidKey: 'test-vapid-key',
        serviceWorkerRegistration: m.sandbox.registration(),
      });
      expect(seen).toHaveLength(1);
      await expect(
        m.register(messaging, { serviceWorkerRegistration: 'bad' }),
      ).rejects.toMatchObject({ code: 'messaging/invalid-sw-registration' });
      sandbox.dispose();
    },

    'messaging#27': async () => {
      const m = await loadClient();
      const sw = await loadSw();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-27' }, 'msg-reg-27');
      const clientMessaging = m.getMessaging(app);
      const swMessaging = sw.getMessaging(app);

      expect('register' in sw).toBe(false);
      expect('unregister' in sw).toBe(false);

      const swSeen: string[] = [];
      const pageSeen: string[] = [];
      const unsubSw = sw.onRegistered(swMessaging, (fid: string) => swSeen.push(fid));
      m.onRegistered(clientMessaging, (fid: string) => pageSeen.push(fid));
      await m.register(clientMessaging);
      expect(swSeen).toEqual(pageSeen);
      expect(swSeen).toHaveLength(1);

      unsubSw();
      await m.register(clientMessaging);
      expect(swSeen).toHaveLength(1);
      sandbox.dispose();
    },

    'messaging#28': async () => {
      const m = await loadClient();
      const sw = await loadSw();
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: 'msg-reg-28' }, 'msg-reg-28');
      const clientMessaging = m.getMessaging(app);
      const swMessaging = sw.getMessaging(app);

      const swUnreg: string[] = [];
      let regFid = '';
      m.onRegistered(clientMessaging, (fid: string) => {
        regFid = fid;
      });
      const unsubSw = sw.onUnregistered(swMessaging, {
        next: (fid: string) => swUnreg.push(fid),
        error: () => {},
        complete: () => {},
      });
      await m.register(clientMessaging);
      await m.unregister(clientMessaging);
      expect(swUnreg).toEqual([regFid]);

      unsubSw();
      await m.unregister(clientMessaging);
      expect(swUnreg).toHaveLength(1);
      sandbox.dispose();
    },
  };
}
