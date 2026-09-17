import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';

const hosted = process.env.TEAMS_HOSTED !== '0';

async function signIn(page: Page, name: string) {
  page.on('pageerror', error => console.error(name, error));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error(name, message.text()); });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(`${name}@orbit.example`);
  await page.getByLabel('Password', { exact: true }).fill('orbit-demo');
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
}

test('mentions notify only the recipient, open the channel, and stop after sign-out', async ({ browser, baseURL }) => {
  test.skip(!hosted, 'Cross-profile sharing requires the Node host.');
  const alice = await browser.newContext({ baseURL, permissions: ['notifications'] });
  const david = await browser.newContext({ baseURL, permissions: ['notifications'] });
  try {
    const recipient = await alice.newPage();
    const sender = await david.newPage();
    await signIn(recipient, 'alice');
    await signIn(sender, 'david');
    await sender.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(sender.getByText('Notifications enabled on this browser.')).toBeVisible();
    await recipient.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(recipient.getByText('Notifications enabled on this browser.')).toBeVisible();
    const reaction = sender.getByRole('button', { name: 'React to message by Alice Chen', exact: true }).first();
    await reaction.click();
    await expect(reaction).toContainText('1');
    await sender.getByRole('button', { name: 'team-lounge', exact: true }).click();
    const message = `@alice @alice @david please review ${Date.now()}`;
    await sender.getByRole('textbox', { name: 'Message' , exact: true }).fill(message);
    await sender.getByRole('button', { name: 'Send message', exact: true }).click();
    const notification = recipient.getByRole('button', { name: new RegExp(`David East mentioned you.*${message}`) });
    await expect(notification).toBeVisible();
    await expect(recipient.locator(".notification-item")).toHaveCount(1);
    await expect(sender.getByText('No mentions yet.')).toBeVisible();
    await recipient.screenshot({ path: '/tmp/orbit-notifications-desktop.png' });
    await recipient.setViewportSize({ width: 390, height: 844 });
    await recipient.screenshot({ path: '/tmp/orbit-notifications-mobile.png' });
    await expect(recipient.locator('body')).toHaveJSProperty('scrollWidth', 390);
    await notification.click();
    await expect(recipient.locator('.conversation-body').getByText(message, { exact: true })).toBeVisible();
    await recipient.setViewportSize({ width: 1280, height: 800 });
    await recipient.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(recipient.getByLabel('Email', { exact: true })).toBeVisible();
    await signIn(recipient, 'marcus');
    await recipient.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(recipient.getByText('Notifications enabled on this browser.')).toBeVisible();
    await sender.getByRole('textbox', { name: 'Message', exact: true }).fill('@alice this is private to Alice');
    await sender.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(sender.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await sender.getByRole('textbox', { name: 'Message', exact: true }).fill('@marcus welcome Marcus');
    await sender.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(recipient.locator('.notification-item')).toHaveCount(1);
    await expect(recipient.locator('.notification-item')).toContainText('@marcus welcome Marcus');
  } finally {
    await alice.close();
    await david.close();
  }
});

test('a hidden recipient receives the mention through the real Service Worker', async ({ browser, baseURL }) => {
  test.skip(!hosted, 'Cross-profile sharing requires the Node host.');
  const alice = await browser.newContext({ baseURL, permissions: ['notifications'] });
  const david = await browser.newContext({ baseURL });
  try {
    const recipient = await alice.newPage();
    const sender = await david.newPage();
    await signIn(recipient, 'alice');
    await signIn(sender, 'david');
    await recipient.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(recipient.getByText('Notifications enabled on this browser.')).toBeVisible();
    await recipient.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      // An acknowledged app operation orders the preceding visibility update.
      const { database } = await import(String('/test-sdk.ts'));
      await database.set(database.ref(database.getDatabase(), 'typing/design/alice'), '');
    });
    const delivered = recipient.evaluate(() => new Promise<string>(resolve => {
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'orbit-mention') resolve(event.data.data.body);
      }, { once: true });
    }));
    const message = `@alice background review ${Date.now()}`;
    await sender.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
    await sender.getByRole('button', { name: 'Send message', exact: true }).click();
    expect(await delivered).toBe(message);
    await expect(recipient.locator('.notification-item')).toContainText(message);
  } finally {
    await alice.close();
    await david.close();
  }
});

test('denied permission explains how to recover without enabling notifications', async ({ page }) => {
  test.skip(!hosted, 'Run account and permission cases on the shared Node host.');
  await page.addInitScript(() => { Notification.requestPermission = async () => 'denied'; });
  await signIn(page, 'alice');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications are blocked for this site or browser session. Use a regular browser window and allow notifications in this site’s permissions.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable notifications', exact: true })).toBeEnabled();
});

test('notification tokens and requests stay private and message authors cannot be forged', async ({ page }) => {
  test.skip(!hosted, 'The hosted suite verifies the same deployed rules.');
  await signIn(page, 'david');
  const outcomes = await page.evaluate(async () => {
    const { firestore, database } = await import(String('/test-sdk.ts'));
    const db = firestore.getFirestore();
    const rtdb = database.getDatabase();
    const denied = async (action: () => Promise<unknown>) => {
      try { await action(); return false; } catch { return true; }
    };
    return {
      readTokens: await denied(() => database.get(database.ref(rtdb, 'notificationTokens/alice'))),
      writeTokens: await denied(() => database.set(database.ref(rtdb, 'notificationTokens/alice/forged'), 'token')),
      forgeRequest: await denied(() => database.set(database.ref(rtdb, 'mentionRequests/alice/forged'), 'design')),
      forgeAuthor: await denied(() => firestore.setDoc(firestore.doc(db, 'workspaces/orbit/channels/design/messages/forged'), { author: 'alice', text: '@david forged', created: Date.now(), parent: '', reactions: 0 })),
    };
  });
  expect(outcomes).toEqual({ readTokens: true, writeTokens: true, forgeRequest: true, forgeAuthor: true });
});

test('SharedWorker receives a backend mention through the bridge', async ({ page, baseURL }) => {
  test.skip(hosted, 'The separate Node-host tests cover two real profiles.');
  await page.context().grantPermissions(['notifications']);
  await signIn(page, 'alice');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  const { connectRemoteSandbox } = await import('@pyric/cli/remote');
  const remote = await connectRemoteSandbox({ url: baseURL! });
  try {
    const id = `shared-${Date.now()}`;
    await remote.channel.op({
      method: 'setDoc', path: `workspaces/orbit/channels/design/messages/${id}`,
      actAs: { mode: 'admin' },
      data: { author: 'david', text: '@alice review from the backend', created: Date.now(), parent: '', reactions: 0 },
    });
    await remote.rtdb.set(`mentionRequests/david/${id}`, 'design');
    await expect(page.locator('.notification-item')).toContainText('@alice review from the backend');
    await page.reload();
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
    await remote.channel.op({
      method: 'setDoc', path: `workspaces/orbit/channels/design/messages/${id}-reload`,
      actAs: { mode: 'admin' },
      data: { author: 'david', text: '@alice after reload', created: Date.now(), parent: '', reactions: 0 },
    });
    await remote.rtdb.set(`mentionRequests/david/${id}-reload`, 'design');
    await expect(page.locator('.notification-item')).toContainText('@alice after reload');
  } finally {
    await remote.close();
  }
});

test('an opted-in browser restores notifications after reload', async ({ page }) => {
  test.skip(!hosted, 'The SharedWorker delivery scenario includes its own reload.');
  await page.context().grantPermissions(['notifications']);
  await signIn(page, 'alice');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
});


test('external identity switches preserve opt-in and never delete another user token path', async ({ page }) => {
  await page.context().grantPermissions(['notifications']);
  const cleanupErrors: string[] = [];
  page.on('console', message => {
    const cleanupFailed = message.text().includes('Notification cleanup failed.');
    if (cleanupFailed) cleanupErrors.push(message.text());
  });
  await signIn(page, 'alice');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  const switchUser = async (uid: string) => {
    await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
    await page.getByRole('tab', { name: 'Identity', exact: true }).click();
    await page.locator(`[data-switch-user="${uid}"]`).click();
    await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
  };
  await switchUser('david');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  expect(cleanupErrors).toEqual([]);
  await switchUser('alice');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  expect(cleanupErrors).toEqual([]);
});

test('stalled notification registration times out and can be retried', async ({ page }) => {
  await page.context().grantPermissions(['notifications']);
  await signIn(page, 'alice');
  await page.evaluate(() => {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    let first = true;
    navigator.serviceWorker.register = (...args) => {
      if (!first) return register(...args);
      first = false;
      return new Promise(() => {});
    };
  });
  await page.clock.install();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enabling…', exact: true })).toBeVisible();
  await page.clock.fastForward(15_000);
  await expect(page.getByRole('button', { name: 'Enable notifications', exact: true })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'timed out' })).toBeVisible();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
});


test('an externally switched profile receives only the new account mentions', async ({ browser, baseURL }) => {
  test.skip(!hosted, 'Cross-profile delivery requires the Node host.');
  const recipientContext = await browser.newContext({ baseURL, permissions: ['notifications'] });
  const senderContext = await browser.newContext({ baseURL });
  try {
    const recipient = await recipientContext.newPage();
    const sender = await senderContext.newPage();
    await signIn(recipient, 'alice');
    await recipient.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(recipient.getByText('Notifications enabled on this browser.')).toBeVisible();
    await recipient.evaluate(async () => {
      const { auth } = await import(String('/test-sdk.ts'));
      await auth.signOut(auth.getAuth());
    });
    await expect(recipient.getByLabel('Email', { exact: true })).toBeVisible();
    await signIn(recipient, 'marcus');
    await recipient.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(recipient.getByText('Notifications enabled on this browser.')).toBeVisible();
    await signIn(sender, 'david');
    for (const uid of ['alice', 'marcus']) {
      await sender.getByRole('textbox', { name: 'Message', exact: true }).fill(`@${uid} account switch check`);
      await sender.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(sender.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    }
    await expect(recipient.locator('.notification-item')).toHaveCount(1);
    await expect(recipient.locator('.notification-item')).toContainText('@marcus account switch check');
  } finally {
    await recipientContext.close();
    await senderContext.close();
  }
});

test('switching accounts during pending registration ignores its late result', async ({ page }) => {
  await page.context().grantPermissions(['notifications']);
  await signIn(page, 'alice');
  await page.evaluate(() => {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = (...args) => {
      navigator.serviceWorker.register = register;
      return new Promise((resolve, reject) => {
        window.addEventListener('finish-registration', () => void register(...args).then(resolve, reject), { once: true });
      });
    };
  });
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'registering the notification worker' })).toBeVisible();
  await page.evaluate(async () => {
    const { auth } = await import(String('/test-sdk.ts'));
    await auth.signInWithEmailAndPassword(auth.getAuth(), 'david@orbit.example', 'orbit-demo');
  });
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('finish-registration')));
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
});

test('device display test explains when notifications have not been enabled', async ({ page }) => {
  await signIn(page, 'david');
  const button = page.getByRole('button', { name: 'Test device notification', exact: true });
  await button.click();
  await expect(page.getByText('Enable notifications first, then run the device test.')).toBeVisible();
  await expect(button).toBeEnabled();
});

test('device display test reports browser rejection and allows retry', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await signIn(page, 'david');
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
  // The OS display boundary is exercised separately by the opt-in native test.
  await page.evaluate(() => {
    let attempts = 0;
    ServiceWorkerRegistration.prototype.showNotification = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Device notifications are blocked.');
    };
  });
  const button = page.getByRole('button', { name: 'Test device notification', exact: true });
  await button.click();
  await expect(page.getByText('Device notifications are blocked.')).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText('Browser accepted the notification. Check your device’s notifications.')).toBeVisible();
  await expect(page.getByText('Device notifications are blocked.')).toHaveCount(0);
});

test('device display test registers a native notification without a messaging delivery', async ({ baseURL }) => {
  test.skip(process.env.ORBIT_NATIVE_NOTIFICATIONS !== '1', 'Native display requires a regular headed browser and desktop notification support.');
  const profile = await mkdtemp(join(tmpdir(), 'orbit-notification-display-'));
  try {
    const context = await chromium.launchPersistentContext(profile, { headless: false, baseURL, permissions: ['notifications'] });
    try {
      await context.grantPermissions(['notifications'], { origin: baseURL });
      const page = await context.newPage();
      await signIn(page, 'david');
      await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await expect(page.getByText('Notifications enabled on this browser.')).toBeVisible();
      await page.getByRole('button', { name: 'Test device notification', exact: true }).click();
      await expect(page.getByText('Browser accepted the notification. Check your device’s notifications.')).toBeVisible();
      const shown = await page.evaluate(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const notifications = (await Promise.all(registrations.map(registration => registration.getNotifications()))).flat();
        const notification = notifications.find(item => item.tag === 'orbit-device-display-test');
        const result = notification ? { title: notification.title, channel: notification.data.channel } : null;
        notification?.close();
        return result;
      });
      expect(shown).toEqual({ title: 'Orbit device notification test', channel: 'design' });
      await expect(page.locator('.notification-item')).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: '/tmp/orbit-device-notification-test.png' });
      await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    } finally {
      await context.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
