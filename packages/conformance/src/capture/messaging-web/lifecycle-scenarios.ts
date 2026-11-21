import { join } from 'node:path';
import type { App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type {
  MessagingWebCaptureEvent,
  MultiDeviceFanoutRawResult,
  TokenRotationRawResult,
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

async function waitDeviceCapture(
  captures: readonly MessagingWebCaptureEvent[],
  kind: string,
  device: string | undefined,
  fromIdx: number,
  timeoutMs: number,
  tag?: string,
): Promise<MessagingWebCaptureEvent> {
  const start = Date.now();
  for (;;) {
    const slice = captures.slice(fromIdx);
    const hit = slice.find((c) => {
      if (c.kind !== kind) return false;
      if (device !== undefined && c.device !== device) return false;
      if (device === undefined && c.device !== undefined) return false;
      if (tag !== undefined && tagOfEvent(c) !== tag) return false;
      return true;
    });
    if (hit) return hit;
    const err = slice.find((c) => c.kind === 'error' && (device === undefined || c.device === device));
    if (err) {
      throw new Error(`page error (${device ?? 'primary'}): ${JSON.stringify(err.data)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout waiting for ${kind}${tag ? '#' + tag : ''} on ${device ?? 'primary'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function verifyDeviceSilent(
  captures: readonly MessagingWebCaptureEvent[],
  device: string,
  tag: string,
  fromIdx: number,
  windowMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const leaked = captures
      .slice(fromIdx)
      .some(
        (c) =>
          c.device === device &&
          (c.kind === 'onMessage' || c.kind === 'onBackgroundMessage') &&
          tagOfEvent(c) === tag,
      );
    if (leaked) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
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

export interface MultiDeviceFanoutDriverDeps {
  chromium: ChromiumType;
  channel: string;
  origin: string;
  admin: App;
  primaryPage: PageType;
  primaryToken: string;
  captures: readonly MessagingWebCaptureEvent[];
  sendTo: (token: string, tag: string) => Promise<string>;
}

export async function runMultiDeviceFanoutScenario(
  deps: MultiDeviceFanoutDriverDeps,
): Promise<MultiDeviceFanoutRawResult> {
  const { chromium, channel, origin, admin, primaryPage, primaryToken, captures, sendTo } = deps;
  const secondProfileDir = join(
    process.env.TMPDIR ?? '/tmp',
    'pyric-messaging-oracle-profile-device2',
  );
  const launchOpts: Parameters<ChromiumType['launchPersistentContext']>[1] = {
    headless: false,
    ignoreDefaultArgs: OCCLUSION_ARGS,
  };
  if (channel === 'chrome') {
    launchOpts.channel = 'chrome';
  }

  const context2 = await chromium.launchPersistentContext(secondProfileDir, launchOpts);
  let page2: PageType | null = null;
  let secondToken: string | null = null;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const topic = `pyric-oracle-fanout-${runId}`;
  let subscribedToTopic = false;
  let cleanupTopicUnsubscribeSuccessCount = 0;
  let cleanupSecondDeviceDeletedTruthy = false;

  try {
    page2 = context2.pages()[0] ?? (await context2.newPage());
    await grantOriginPushPermissions(context2, page2, origin);

    const bootMark = captures.length;
    await primaryPage.goto(origin);
    await waitDeviceCapture(captures, 'listening', undefined, bootMark, 30_000);
    await primaryPage.bringToFront();

    const boot2Mark = captures.length;
    await page2.goto(`${origin}/?device=device-2`);
    const tok2Event = await waitDeviceCapture(captures, 'token', 'device-2', boot2Mark, 30_000);
    secondToken = (tok2Event.data as { token: string }).token;
    await waitDeviceCapture(captures, 'listening', 'device-2', boot2Mark, 15_000);
    await page2.bringToFront();

    // 1. Token-targeted send to primaryToken reaches device 1 only, never device 2.
    const singleMark = captures.length;
    await sendTo(primaryToken, 'single-device-1');
    await waitDeviceCapture(captures, 'onMessage', undefined, singleMark, 45_000, 'single-device-1');
    const tokenTargetSilentOnDevice2 = await verifyDeviceSilent(
      captures,
      'device-2',
      'single-device-1',
      singleMark,
      4_000,
    );

    // 2. Subscribe both tokens to one topic and send once: both devices receive independently.
    const subOutcome = await getMessaging(admin).subscribeToTopic(
      [primaryToken, secondToken],
      topic,
    );
    subscribedToTopic = true;
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const topicTag = `topic-fanout-${runId}`;
    const topicMark = captures.length;
    await getMessaging(admin).send({
      topic,
      notification: { title: `oracle ${topicTag}`, body: 'topic multi-device fanout' },
      data: { source: 'messaging-web-harness', tag: topicTag, demo: '1' },
    });
    const [dev1Topic, dev2Topic] = await Promise.all([
      waitDeviceCapture(captures, 'onMessage', undefined, topicMark, 45_000, topicTag),
      waitDeviceCapture(captures, 'onMessage', 'device-2', topicMark, 45_000, topicTag),
    ]);

    // 3. Multicast send across both tokens: both devices receive independently.
    const multiTag = `multicast-fanout-${runId}`;
    const multiMark = captures.length;
    const multiOutcome = await getMessaging(admin).sendEachForMulticast({
      tokens: [primaryToken, secondToken],
      notification: { title: `oracle ${multiTag}`, body: 'multicast multi-device fanout' },
      data: { source: 'messaging-web-harness', tag: multiTag, demo: '1' },
    });
    const [dev1Multi, dev2Multi] = await Promise.all([
      waitDeviceCapture(captures, 'onMessage', undefined, multiMark, 45_000, multiTag),
      waitDeviceCapture(captures, 'onMessage', 'device-2', multiMark, 45_000, multiTag),
    ]);

    const unsubOutcome = await getMessaging(admin).unsubscribeFromTopic(
      [primaryToken, secondToken],
      topic,
    );
    subscribedToTopic = false;
    cleanupTopicUnsubscribeSuccessCount = unsubOutcome.successCount;

    const mintedSecondToken = secondToken;
    const distinctTokensMinted =
      mintedSecondToken.length > 0 && mintedSecondToken !== primaryToken;
    const sameTokenShapeLength = mintedSecondToken.length === primaryToken.length;

    const del2 = await page2.evaluate('window.__deleteToken()');
    secondToken = null;
    cleanupSecondDeviceDeletedTruthy = del2 === true || del2 === undefined;

    return {
      distinctTokensMinted,
      sameTokenShapeLength,
      tokenTargetDeliveredToDevice1: true,
      tokenTargetSilentOnDevice2,
      topicSubscribeSuccessCount: subOutcome.successCount,
      topicSubscribeFailureCount: subOutcome.failureCount,
      topicSendDeliveredToDevice1: Boolean(dev1Topic),
      topicSendDeliveredToDevice2: Boolean(dev2Topic),
      multicastSuccessCount: multiOutcome.successCount,
      multicastFailureCount: multiOutcome.failureCount,
      multicastDeliveredToDevice1: Boolean(dev1Multi),
      multicastDeliveredToDevice2: Boolean(dev2Multi),
      cleanupTopicUnsubscribeSuccessCount,
      cleanupSecondDeviceDeletedTruthy,
    };
  } finally {
    if (subscribedToTopic && secondToken !== null) {
      await getMessaging(admin)
        .unsubscribeFromTopic([primaryToken, secondToken], topic)
        .catch(() => undefined);
    }
    if (page2 !== null && secondToken !== null) {
      await page2.evaluate('window.__deleteToken()').catch(() => undefined);
    }
    await context2.close().catch(() => undefined);
  }
}

export interface TokenRotationDriverDeps {
  origin: string;
  page: PageType;
  captures: readonly MessagingWebCaptureEvent[];
  sendTo: (token: string, tag: string) => Promise<string>;
  rawSend: (token: string, tag: string) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function runTokenRotationScenario(
  deps: TokenRotationDriverDeps,
): Promise<{ result: TokenRotationRawResult; latestToken: string }> {
  const { origin, page, captures, sendTo, rawSend } = deps;
  const swMod = (await import('firebase/messaging/sw')) as Record<string, unknown>;
  const swHasOnTokenRefresh = 'onTokenRefresh' in swMod;

  const mark = captures.length;
  await page.goto(origin);
  const priorCap = await waitDeviceCapture(captures, 'token', undefined, mark, 30_000);
  await waitDeviceCapture(captures, 'listening', undefined, mark, 15_000);
  await page.bringToFront();

  const priorToken = (priorCap.data as { token: string }).token;
  const sdkFacts = (await page.evaluate('window.__sdkLifecycleFacts()')) as {
    clientHasOnTokenRefresh: boolean;
  };
  const rotated = (await page.evaluate('window.__rotatePushSubscriptionAndGetToken()')) as {
    pushUnsubscribed: boolean;
    rotatedToken: string;
  };
  const rotatedToken = rotated.rotatedToken;

  const fgMark = captures.length;
  await sendTo(rotatedToken, 'rotated-new-token');
  await waitDeviceCapture(captures, 'onMessage', undefined, fgMark, 45_000, 'rotated-new-token');

  const priorLeakFrom = captures.length;
  const first = await rawSend(priorToken, 'rotated-prior-token');
  let unreg: { status: number; body: Record<string, unknown> } | null = null;
  if (first.status >= 400) {
    unreg = first;
  }
  const deadline = Date.now() + 150_000;
  while (unreg === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const pollRes = await rawSend(priorToken, 'rotated-prior-token');
    if (pollRes.status >= 400) {
      unreg = pollRes;
    }
  }

  const leakedPrior = captures
    .slice(priorLeakFrom)
    .some(
      (c) =>
        c.device === undefined &&
        (c.kind === 'onMessage' || c.kind === 'onBackgroundMessage') &&
        tagOfEvent(c) === 'rotated-prior-token',
    );

  let unregSummary: { status: number; error?: Record<string, unknown> } | null = null;
  if (unreg !== null) {
    unregSummary = {
      status: unreg.status,
      error: (unreg.body as { error?: Record<string, unknown> }).error,
    };
  }

  return {
    latestToken: rotatedToken,
    result: {
      clientHasOnTokenRefresh: sdkFacts.clientHasOnTokenRefresh,
      swHasOnTokenRefresh,
      pushSubscriptionUnsubscribed: rotated.pushUnsubscribed,
      rotatedTokenMinted: rotatedToken.length > 0,
      tokenChangedOnRotation: rotatedToken !== priorToken,
      rotatedTokenSameShapeLength: rotatedToken.length === priorToken.length,
      rotatedTokenDeliversForeground: true,
      firstSendToPriorTokenStatus: first.status,
      priorTokenUnregistered: unregSummary,
      noDeliveryFromPriorToken: !leakedPrior,
    },
  };
}
