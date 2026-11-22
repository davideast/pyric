import { join } from 'node:path';
import type { App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type {
  MessagingWebCaptureEvent,
  OfflineStoreAndForwardRawResult,
} from './write-observations.ts';

type ChromiumType = typeof import('@playwright/test').chromium;
type BrowserContextType = import('@playwright/test').BrowserContext;
type PageType = import('@playwright/test').Page;

const OCCLUSION_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

function tagOfEvent(c: MessagingWebCaptureEvent): string | undefined {
  const payload = (c.data as { payload?: { data?: { tag?: string } } }).payload;
  return payload?.data?.tag;
}

async function grantOriginPushPermissions(
  context: BrowserContextType,
  page: PageType,
  origin: string,
): Promise<void> {
  await context.grantPermissions(['notifications'], { origin });
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setPermission', {
      permission: { name: 'push', userVisibleOnly: true },
      setting: 'granted',
      origin,
    } as never);
  } catch {
    // Continue if CDP permission override is unsupported on the selected channel.
  }
}

async function waitDeviceStep(
  captures: readonly MessagingWebCaptureEvent[],
  kind: string,
  device: string,
  fromIdx: number,
  timeoutMs: number,
): Promise<MessagingWebCaptureEvent> {
  const start = Date.now();
  for (;;) {
    const slice = captures.slice(fromIdx);
    const hit = slice.find((c) => c.kind === kind && c.device === device);
    if (hit !== undefined) {
      return hit;
    }
    const err = slice.find((c) => c.kind === 'error' && c.device === device);
    if (err !== undefined) {
      throw new Error(`page error (${device}): ${JSON.stringify(err.data)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${kind} on ${device}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitDeliveryByTag(
  captures: readonly MessagingWebCaptureEvent[],
  tag: string,
  fromIdx: number,
  timeoutMs: number,
): Promise<MessagingWebCaptureEvent> {
  const start = Date.now();
  for (;;) {
    const slice = captures.slice(fromIdx);
    const hit = slice.find(
      (c) => (c.kind === 'onMessage' || c.kind === 'onBackgroundMessage') && tagOfEvent(c) === tag,
    );
    if (hit !== undefined) {
      return hit;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for delivery tag ${tag}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function deliveredTagsSince(
  captures: readonly MessagingWebCaptureEvent[],
  fromIdx: number,
  candidateTags: ReadonlySet<string>,
): string[] {
  const seen: string[] = [];
  for (const event of captures.slice(fromIdx)) {
    if (event.kind !== 'onMessage' && event.kind !== 'onBackgroundMessage') {
      continue;
    }
    const tag = tagOfEvent(event);
    if (tag !== undefined && candidateTags.has(tag) && !seen.includes(tag)) {
      seen.push(tag);
    }
  }
  return seen;
}

export interface OfflineStoreAndForwardDriverDeps {
  chromium: ChromiumType;
  channel: string;
  origin: string;
  admin: App;
  captures: readonly MessagingWebCaptureEvent[];
}

export async function runOfflineStoreAndForwardScenario(
  deps: OfflineStoreAndForwardDriverDeps,
): Promise<OfflineStoreAndForwardRawResult> {
  const { chromium, channel, origin, admin, captures } = deps;
  const deviceName = 'offline-device';
  const offlineProfileDir = join(
    process.env.TMPDIR ?? '/tmp',
    'pyric-messaging-oracle-profile-offline',
  );
  const launchOpts: Parameters<ChromiumType['launchPersistentContext']>[1] = {
    headless: false,
    ignoreDefaultArgs: OCCLUSION_ARGS,
  };
  if (channel === 'chrome') {
    launchOpts.channel = 'chrome';
  }

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const collapseTopic = `col-${runId.slice(-12)}`;
  const onlineBaselineTag = `offline-baseline-${runId}`;
  const expiredTag = `offline-expired-${runId}`;
  const collapseFirstTag = `offline-collapse-1-${runId}`;
  const collapseSecondTag = `offline-collapse-2-${runId}`;
  const queuedNonCollapsibleTag = `offline-queued-${runId}`;

  let context1: BrowserContextType | null = null;
  let context2: BrowserContextType | null = null;
  let page2: PageType | null = null;
  let mintedToken: string | null = null;
  let cleanupTokenDeletedTruthy = false;

  try {
    // Phase 1: launch persistent profile, mint token, confirm live push channel works online.
    context1 = await chromium.launchPersistentContext(offlineProfileDir, launchOpts);
    const page1 = context1.pages()[0] ?? (await context1.newPage());
    await grantOriginPushPermissions(context1, page1, origin);

    const bootMark = captures.length;
    await page1.goto(`${origin}/?device=${deviceName}`);
    const tokEvent = await waitDeviceStep(captures, 'token', deviceName, bootMark, 30_000);
    mintedToken = (tokEvent.data as { token: string }).token;
    await waitDeviceStep(captures, 'listening', deviceName, bootMark, 15_000);
    await page1.bringToFront();

    const baselineMark = captures.length;
    await getMessaging(admin).send({
      token: mintedToken,
      data: { source: 'messaging-web-harness', tag: onlineBaselineTag },
      webpush: { headers: { TTL: '60' } },
    });
    await waitDeliveryByTag(captures, onlineBaselineTag, baselineMark, 45_000);

    // Phase 2: close persistent browser context completely so Chrome's browser-level
    // GCM connection disconnects while keeping the PushSubscription persisted on disk.
    await context1.close();
    context1 = null;
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const offlineSendMark = captures.length;
    const messaging = getMessaging(admin);

    // 2a. Short-TTL message (TTL=1s) sent while offline, then aged past expiry before reconnect.
    await messaging.send({
      token: mintedToken,
      data: { source: 'messaging-web-harness', tag: expiredTag, seq: '0' },
      webpush: { headers: { TTL: '1' } },
      android: { ttl: 1_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    // 2b. Two collapsible messages sharing Topic / collapseKey while offline.
    await messaging.send({
      token: mintedToken,
      data: { source: 'messaging-web-harness', tag: collapseFirstTag, seq: '1' },
      webpush: { headers: { TTL: '300', Topic: collapseTopic } },
      android: { ttl: 300_000, collapseKey: collapseTopic },
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await messaging.send({
      token: mintedToken,
      data: { source: 'messaging-web-harness', tag: collapseSecondTag, seq: '2' },
      webpush: { headers: { TTL: '300', Topic: collapseTopic } },
      android: { ttl: 300_000, collapseKey: collapseTopic },
    });

    // 2c. Non-collapsible queued message within TTL.
    await messaging.send({
      token: mintedToken,
      data: { source: 'messaging-web-harness', tag: queuedNonCollapsibleTag, seq: '3' },
      webpush: { headers: { TTL: '300' } },
      android: { ttl: 300_000 },
    });

    // Phase 3: relaunch the same persistent profile so GCM reconnects and flushes queued messages.
    context2 = await chromium.launchPersistentContext(offlineProfileDir, launchOpts);
    page2 = context2.pages()[0] ?? (await context2.newPage());
    await grantOriginPushPermissions(context2, page2, origin);

    const relaunchMark = captures.length;
    await page2.goto(`${origin}/?device=${deviceName}`);
    const relistenTok = await waitDeviceStep(captures, 'token', deviceName, relaunchMark, 30_000);
    const reconnectedToken = (relistenTok.data as { token: string }).token;
    await waitDeviceStep(captures, 'listening', deviceName, relaunchMark, 15_000);
    await page2.bringToFront();

    await waitDeliveryByTag(captures, queuedNonCollapsibleTag, offlineSendMark, 45_000);
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const trackedTags = new Set([
      expiredTag,
      collapseFirstTag,
      collapseSecondTag,
      queuedNonCollapsibleTag,
    ]);
    const delivered = deliveredTagsSince(captures, offlineSendMark, trackedTags);

    const del = await page2.evaluate('window.__deleteToken()');
    mintedToken = null;
    cleanupTokenDeletedTruthy = del === true || del === undefined;

    return {
      onlineBaselineDelivered: true,
      tokenPreservedAcrossOfflineRestart: reconnectedToken === (tokEvent.data as { token: string }).token,
      nonCollapsibleQueuedDeliveredOnReconnect: delivered.includes(queuedNonCollapsibleTag),
      collapsibleFirstDelivered: delivered.includes(collapseFirstTag),
      collapsibleSecondDelivered: delivered.includes(collapseSecondTag),
      collapsibleReplacedOlderPending:
        !delivered.includes(collapseFirstTag) && delivered.includes(collapseSecondTag),
      expiredShortTtlDelivered: delivered.includes(expiredTag),
      expiredShortTtlDroppedBeforeReconnect: !delivered.includes(expiredTag),
      cleanupTokenDeletedTruthy,
    };
  } finally {
    if (context1 !== null) {
      await context1.close().catch(() => undefined);
    }
    if (page2 !== null && mintedToken !== null) {
      await page2.evaluate('window.__deleteToken()').catch(() => undefined);
    }
    if (context2 !== null) {
      await context2.close().catch(() => undefined);
    }
  }
}
