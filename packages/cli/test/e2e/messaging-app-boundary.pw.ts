import { expect, test } from '@playwright/test';

test('served canonical Messaging imports stay app-owned over the SharedWorker', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const actual = await page.evaluate(async () => {
    const appModule = await import('firebase/app');
    const messagingModule = await import('firebase/messaging');
    const messagingSwModule = await import('firebase/messaging/sw');

    const primary = appModule.getApp();
    const sibling = appModule.initializeApp({ ...primary.options }, 'messaging-sibling');
    const primaryMessaging = messagingModule.getMessaging(primary);
    const siblingMessaging = messagingModule.getMessaging(sibling);
    const primarySwMessaging = messagingSwModule.getMessaging(primary);
    const siblingSwMessaging = messagingSwModule.getMessaging(sibling);

    const primaryToken = await messagingModule.getToken(primaryMessaging);
    const siblingToken = await messagingModule.getToken(siblingMessaging);
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: 'pyric-shared-worker',
    });
    worker.port.start();
    const workerToken = await new Promise<string>((resolve, reject) => {
      const id = 'messaging-browser-boundary';
      worker.port.onmessage = (event) => {
        const message = event.data as {
          t?: string;
          id?: string;
          ok?: boolean;
          value?: { token?: string };
          error?: { message?: string };
        };
        if (message.t !== 'res' || message.id !== id) return;
        if (!message.ok) reject(new Error(message.error?.message ?? 'worker token failed'));
        else resolve(message.value?.token ?? '');
      };
      worker.port.postMessage({
        t: 'op',
        id,
        method: 'messaging.getToken',
        registrationId: 'swreg-port-default',
      });
    });
    worker.port.close();
    await appModule.deleteApp(sibling);

    let retainedError: { code?: string } | null = null;
    try {
      await messagingModule.getToken(siblingMessaging);
    } catch (error) {
      retainedError = error as { code?: string };
    }

    return {
      distinctWindowServices: primaryMessaging !== siblingMessaging,
      distinctSwServices: primarySwMessaging !== siblingSwMessaging,
      distinctPlanes:
        primaryMessaging !== primarySwMessaging
        && siblingMessaging !== siblingSwMessaging,
      appsCorrect:
        primaryMessaging.app === primary
        && siblingMessaging.app === sibling
        && primarySwMessaging.app === primary
        && siblingSwMessaging.app === sibling,
      clientBoundary:
        typeof messagingModule.getToken === 'function'
        && typeof messagingModule.deleteToken === 'function'
        && typeof messagingModule.onMessage === 'function'
        && !('onBackgroundMessage' in messagingModule),
      swBoundary:
        typeof messagingSwModule.onBackgroundMessage === 'function'
        && typeof messagingSwModule.experimentalSetDeliveryMetricsExportedToBigQueryEnabled === 'function'
        && !('getToken' in messagingSwModule)
        && !('deleteToken' in messagingSwModule)
        && !('onMessage' in messagingSwModule),
      tokenShape:
        primaryToken.length === 142
        && primaryToken.includes(':')
        && siblingToken.length === 142
        && siblingToken.includes(':'),
      workerBacked: primaryToken === workerToken,
      retainedErrorCode: retainedError?.code ?? null,
      siblingSurvived: (await messagingModule.getToken(primaryMessaging)).length === 142,
    };
  });

  expect(actual).toEqual({
    distinctWindowServices: true,
    distinctSwServices: true,
    distinctPlanes: true,
    appsCorrect: true,
    clientBoundary: true,
    swBoundary: true,
    tokenShape: true,
    workerBacked: true,
    retainedErrorCode: 'app/app-deleted',
    siblingSurvived: true,
  });
});

test('firebase/messaging/sw receives the shared broker from a real module Service Worker', async ({ context, page }) => {
  await context.grantPermissions(['notifications'], { origin: 'http://127.0.0.1:5180' });
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const actual = await page.evaluate(async () => {
    const register = async (): Promise<{
      registration: ServiceWorkerRegistration;
      active: ServiceWorker;
    }> => {
      const registration = await navigator.serviceWorker.register(
        '/messaging-service-worker.js',
        { type: 'module', scope: '/' },
      );
      const active = registration.active ?? registration.waiting ?? registration.installing;
      if (!active) throw new Error('messaging service worker did not start');
      if (active.state === 'activated') return { registration, active };
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('service worker activation timed out')), 5_000);
        active.addEventListener('statechange', () => {
          if (active.state !== 'activated') return;
          clearTimeout(timeout);
          resolve();
        });
      });
      return { registration, active };
    };
    const first = await register();

    const request = <T>(worker: ServiceWorker, type: string): Promise<T> => new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error(`${type} timed out`)), 5_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data as T);
      };
      worker.postMessage({ type }, [channel.port2]);
    });
    const firstReady = await request<{ ready: true; realmId: string }>(
      first.active,
      'pyric-messaging-ready',
    );

    const delivered = new Promise<unknown>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 2_000);
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type !== 'pyric-background-message') return;
        clearTimeout(timeout);
        resolve(event.data.payload);
      }, { once: true });
    });

    const deliver = (
      id: string,
      source: string,
      notification = false,
    ): Promise<{ route?: string; handlerCount?: number; payload?: unknown }> => {
      const worker = new SharedWorker('/__pyric/sdk/worker.js', {
        type: 'classic',
        name: 'pyric-shared-worker',
      });
      worker.port.start();
      return new Promise((resolve, reject) => {
        worker.port.onmessage = (event) => {
          const message = event.data as {
            t?: string;
            id?: string;
            ok?: boolean;
            value?: { route?: string; handlerCount?: number; payload?: unknown };
            error?: { message?: string };
          };
          if (message.t !== 'res' || message.id !== id) return;
          if (!message.ok) reject(new Error(message.error?.message ?? 'delivery failed'));
          else {
            worker.port.close();
            resolve(message.value ?? {});
          }
        };
        worker.port.postMessage({
          t: 'op',
          id,
          method: 'messaging.deliver',
          spec: {
            data: { source },
            ...(notification
              ? { notification: { title: 'Pyric background notification' } }
              : {}),
            messageId: id,
          },
        });
      });
    };
    const result = await deliver('sw-boundary-message', 'real-service-worker');

    const payload = await delivered as { messageId?: string; data?: Record<string, string> } | null;
    let notificationTitles: string[] = [];
    if (Notification.permission === 'granted') {
      const notificationDelivered = new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'pyric-background-message'
            && event.data.payload?.messageId === 'sw-native-notification') resolve();
        }, { once: true });
      });
      await deliver('sw-native-notification', 'native-display', true);
      await notificationDelivered;
      notificationTitles = (await first.registration.getNotifications())
        .map((notification) => notification.title);
    }
    await first.registration.unregister();

    const second = await register();
    const secondReady = await request<{ ready: true; realmId: string }>(
      second.active,
      'pyric-messaging-ready',
    );
    const restarted = await deliver('sw-restart-message', 'restarted-service-worker');
    await request<{ cleaned: true }>(second.active, 'pyric-messaging-cleanup');
    await second.registration.unregister();

    return {
      permission: Notification.permission,
      route: result.route ?? null,
      handlerCount: result.handlerCount ?? null,
      messageId: payload?.messageId ?? null,
      source: payload?.data?.source ?? null,
      notificationTitles,
      replacedRealm: firstReady.realmId !== secondReady.realmId,
      restartedHandlerCount: restarted.handlerCount ?? null,
    };
  });

  expect(actual).toMatchObject({
    route: 'background',
    handlerCount: 1,
    messageId: 'sw-boundary-message',
    source: 'real-service-worker',
    replacedRealm: true,
    restartedHandlerCount: 1,
  });
  expect(['granted', 'denied']).toContain(actual.permission);
  expect(actual.notificationTitles).toEqual(
    actual.permission === 'granted' ? ['Pyric background notification'] : [],
  );
});
