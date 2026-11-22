import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MessagingWebCaptureEvent {
  kind: string;
  data: Record<string, unknown>;
  device?: string;
  at: number;
}

export const MESSAGING_WEB_SCENARIO_NAMES = [
  'onmessage-foreground',
  'token-stability',
  'visible-unfocused',
  'data-only-background',
  'onbackgroundmessage',
  'multi-device-fanout',
  'token-rotation',
  'offline-store-and-forward',
  'deletetoken-unregistered',
] as const;

export type MessagingWebScenarioName = (typeof MESSAGING_WEB_SCENARIO_NAMES)[number];

export interface MultiDeviceFanoutRawResult {
  distinctTokensMinted: boolean;
  sameTokenShapeLength: boolean;
  tokenTargetDeliveredToDevice1: boolean;
  tokenTargetSilentOnDevice2: boolean;
  topicSubscribeSuccessCount: number;
  topicSubscribeFailureCount: number;
  topicSendDeliveredToDevice1: boolean;
  topicSendDeliveredToDevice2: boolean;
  multicastSuccessCount: number;
  multicastFailureCount: number;
  multicastDeliveredToDevice1: boolean;
  multicastDeliveredToDevice2: boolean;
  cleanupTopicUnsubscribeSuccessCount: number;
  cleanupSecondDeviceDeletedTruthy: boolean;
}

export interface TokenRotationRawResult {
  clientHasOnTokenRefresh: boolean;
  swHasOnTokenRefresh: boolean;
  pushSubscriptionUnsubscribed: boolean;
  rotatedTokenMinted: boolean;
  tokenChangedOnRotation: boolean;
  rotatedTokenSameShapeLength: boolean;
  rotatedTokenDeliversForeground: boolean;
  firstSendToPriorTokenStatus: number;
  priorTokenUnregistered: { status: number; error?: Record<string, unknown> } | null;
  noDeliveryFromPriorToken: boolean;
}

export interface DeleteTokenRawResult {
  deleteResolvedTruthy: boolean;
  adminThrow: { code?: string; httpStatus?: string; message?: string } | null;
  firstSendStatus: number;
  acceptedImmediatelyAfterDelete: boolean;
  unregistered: { status: number; error?: Record<string, unknown> } | null;
  noDeliveryToClient: boolean;
}

export interface OfflineStoreAndForwardRawResult {
  onlineBaselineDelivered: boolean;
  tokenPreservedAcrossOfflineRestart: boolean;
  nonCollapsibleQueuedDeliveredOnReconnect: boolean;
  collapsibleFirstDelivered: boolean;
  collapsibleSecondDelivered: boolean;
  collapsibleReplacedOlderPending: boolean;
  expiredShortTtlDelivered: boolean;
  expiredShortTtlDroppedBeforeReconnect: boolean;
  cleanupTokenDeletedTruthy: boolean;
}

export interface MessagingWebRawResults {
  fg?: MessagingWebCaptureEvent;
  tokenStable?: Record<string, unknown>;
  vuf?: MessagingWebCaptureEvent;
  dataOnly?: MessagingWebCaptureEvent;
  bg?: MessagingWebCaptureEvent;
  multiDeviceFanout?: MultiDeviceFanoutRawResult;
  tokenRotation?: TokenRotationRawResult;
  offlineStoreAndForward?: OfflineStoreAndForwardRawResult;
  deleteToken?: DeleteTokenRawResult;
}

export function parseSelectedMessagingWebScenarios(
  argv: readonly string[],
): Set<MessagingWebScenarioName> {
  const known = new Set<string>(MESSAGING_WEB_SCENARIO_NAMES);
  const selected: MessagingWebScenarioName[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    let rawValue: string | null = null;
    if (arg === '--only' || arg === '--scenario') {
      rawValue = argv[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith('--only=')) {
      rawValue = arg.slice('--only='.length);
    } else if (arg.startsWith('--scenario=')) {
      rawValue = arg.slice('--scenario='.length);
    }
    if (rawValue === null) continue;
    const parts = rawValue
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    for (const part of parts) {
      if (!known.has(part)) {
        throw new Error(
          `unknown messaging-web scenario '${part}' (expected one of: ${MESSAGING_WEB_SCENARIO_NAMES.join(', ')})`,
        );
      }
      const typed = part as MessagingWebScenarioName;
      if (!selected.includes(typed)) {
        selected.push(typed);
      }
    }
  }

  if (selected.length === 0) {
    return new Set(MESSAGING_WEB_SCENARIO_NAMES);
  }
  return new Set(selected);
}

export function payloadOfCapture(c: MessagingWebCaptureEvent): Record<string, unknown> {
  return (c.data as { payload: Record<string, unknown> }).payload;
}

export function metaOfCapture(c: MessagingWebCaptureEvent): Record<string, unknown> {
  return ((c.data as { meta?: Record<string, unknown> }).meta) ?? {};
}

export function payloadFacts(
  payload: Record<string, unknown>,
  tag: string,
  senderId: string | undefined,
): Record<string, unknown> {
  const notification = payload.notification as Record<string, unknown> | undefined;
  const data = payload.data as Record<string, string> | undefined;
  return {
    topLevelKeys: Object.keys(payload).sort(),
    notificationKeys: notification ? Object.keys(notification).sort() : null,
    notificationTitleDelivered: notification?.title === `oracle ${tag}`,
    dataKeys: data ? Object.keys(data).sort() : null,
    dataEchoedExactly: data?.source === 'messaging-web-harness' && data?.tag === tag,
    fromEqualsSenderId: payload.from === senderId,
    messageIdPresent: typeof payload.messageId === 'string' && payload.messageId.length > 0,
  };
}

export interface WriteMessagingWebObservationsOptions {
  obsDir: string;
  projectId: string;
  senderId: string | undefined;
  fbSdkVersion: string;
  adminSdkVersion: string;
  initialToken: string | null;
  writeTokenShape: boolean;
  results: MessagingWebRawResults;
  log?: (line: string) => void;
  writeFile?: (filePath: string, content: string) => void;
}

export function writeMessagingWebObservations(
  options: WriteMessagingWebObservationsOptions,
): string[] {
  const { obsDir, projectId, senderId, fbSdkVersion, adminSdkVersion, results } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const write = options.writeFile ?? ((filePath: string, content: string) => writeFileSync(filePath, content));
  const written: string[] = [];

  function writeOne(
    name: string,
    rowIds: string[],
    description: string,
    behavior: Record<string, unknown>,
    versions: Record<string, string> = { fbSdkVersion },
  ): void {
    write(
      join(obsDir, `${name}.json`),
      `${JSON.stringify(
        {
          name,
          matrixRow: rowIds.join(', '),
          rowIds,
          description: `${description} Cited by ${rowIds.join(', ')} (surface climbing under CDD; cited, not yet replayed).`,
          observedAt: new Date().toISOString(),
          ...versions,
          projectId,
          behavior,
        },
        null,
        2,
      )}\n`,
    );
    written.push(name);
    log(`wrote ${name}`);
  }

  if (options.writeTokenShape && options.initialToken !== null) {
    const token = options.initialToken;
    writeOne(
      'messaging-web-token-shape',
      ['messaging#2'],
      'getToken(messaging, { vapidKey, serviceWorkerRegistration }) against production FCM: token format facts. Probe: real Chromium, localhost secure context, permission granted, real registration API.',
      {
        minted: true,
        length: token.length,
        colonSeparated: token.includes(':'),
        suffixAfterColonStartsWithAPA91b: token.split(':')[1]?.startsWith('APA91b') ?? false,
        urlSafe: /^[A-Za-z0-9_:-]+$/.test(token),
      },
    );
  }

  if (results.fg) {
    writeOne(
      'messaging-web-onmessage-foreground',
      ['messaging#4', 'messaging#8', 'messaging#9'],
      'A notification+data message sent to a token while the page is FOCUSED is delivered to onMessage (not the SW). Payload structural facts; prod noise (ids, token) reduced to shape.',
      { deliveredTo: 'onMessage', ...payloadFacts(payloadOfCapture(results.fg), 'foreground', senderId) },
    );
  }

  if (results.tokenStable) {
    writeOne(
      'messaging-web-token-stability',
      ['messaging#2'],
      'getToken(messaging, { vapidKey, serviceWorkerRegistration }) called a second time on the SAME service-worker registration returns the SAME token - no per-call rotation. Token value is prod noise; only the equality/shape facts are kept.',
      results.tokenStable,
    );
  }

  if (results.vuf && results.bg) {
    const vufMeta = metaOfCapture(results.vuf);
    writeOne(
      'messaging-web-visibility-routing',
      ['messaging#4', 'messaging#14'],
      "FCM receive routing keys on page VISIBILITY, not focus: the firebase/messaging service worker decides foreground vs background solely by whether a window client reports visibilityState 'visible' (it never inspects focus). A page that is visibilityState 'visible' receives onMessage; a page with NO visible client (navigated away) routes to the service-worker onBackgroundMessage instead - both captured here.",
      {
        routesOnVisibilityNotFocus: true,
        visibleClient: {
          deliveredTo: 'onMessage',
          visibilityStateAtDelivery: vufMeta.visibilityState,
          pageHadFocusAtDelivery: vufMeta.hasFocus,
          unfocusedSampleForcedUnderAutomation: false,
        },
        noVisibleClient: { deliveredTo: 'onBackgroundMessage' },
      },
    );
  }

  if (results.bg) {
    writeOne(
      'messaging-web-onbackgroundmessage',
      ['messaging#8', 'messaging#14'],
      'A notification+data message sent while the page has NO visible client is delivered to the service worker onBackgroundMessage handler instead of onMessage. Payload structural facts.',
      { deliveredTo: 'onBackgroundMessage', ...payloadFacts(payloadOfCapture(results.bg), 'bg', senderId) },
    );
  }

  if (results.dataOnly) {
    const payload = payloadOfCapture(results.dataOnly);
    const meta = metaOfCapture(results.dataOnly);
    writeOne(
      'messaging-web-data-only-background',
      ['messaging#14'],
      'A DATA-ONLY message (no notification field) sent while the page has no visible client: onBackgroundMessage FIRES, delivering a payload with data/from/messageId and NO notification key.',
      {
        onBackgroundMessageFired: true,
        topLevelKeys: Object.keys(payload).sort(),
        hasNotificationKey: 'notification' in payload,
        dataKeys: payload.data ? Object.keys(payload.data as object).sort() : null,
        dataEchoedExactly:
          (payload.data as Record<string, string> | undefined)?.source === 'messaging-web-harness' &&
          (payload.data as Record<string, string> | undefined)?.tag === 'data-only',
        fromEqualsSenderId: payload.from === senderId,
        messageIdPresent: typeof payload.messageId === 'string' && payload.messageId.length > 0,
        notificationsAfterHandler: meta.notificationsAfterHandler,
      },
    );
  }

  if (results.multiDeviceFanout) {
    const m = results.multiDeviceFanout;
    writeOne(
      'messaging-web-multi-device-fanout',
      ['messaging#19'],
      'Two independent persistent Chromium browser profiles on the same Firebase Web App mint two distinct FCM registration tokens; a token-targeted send delivers exclusively to the targeted profile, whereas topic and multicast sends fan out independently to both profiles with zero server-side cross-device de-duplication.',
      {
        distinctTokensMinted: m.distinctTokensMinted,
        sameTokenShapeLength: m.sameTokenShapeLength,
        tokenTargetDeliveredToDevice1: m.tokenTargetDeliveredToDevice1,
        tokenTargetSilentOnDevice2: m.tokenTargetSilentOnDevice2,
        topicSubscribeSuccessCount: m.topicSubscribeSuccessCount,
        topicSubscribeFailureCount: m.topicSubscribeFailureCount,
        topicSendDeliveredToDevice1: m.topicSendDeliveredToDevice1,
        topicSendDeliveredToDevice2: m.topicSendDeliveredToDevice2,
        deduplicatedAcrossDevices: !(m.topicSendDeliveredToDevice1 && m.topicSendDeliveredToDevice2),
        multicastSuccessCount: m.multicastSuccessCount,
        multicastFailureCount: m.multicastFailureCount,
        multicastDeliveredToDevice1: m.multicastDeliveredToDevice1,
        multicastDeliveredToDevice2: m.multicastDeliveredToDevice2,
        cleanupTopicUnsubscribeSuccessCount: m.cleanupTopicUnsubscribeSuccessCount,
        cleanupSecondDeviceDeletedTruthy: m.cleanupSecondDeviceDeletedTruthy,
      },
      { fbSdkVersion, adminSdkVersion },
    );
  }

  if (results.tokenRotation) {
    const r = results.tokenRotation;
    const err = r.priorTokenUnregistered?.error ?? {};
    const details = (err.details as Array<Record<string, unknown>> | undefined) ?? [];
    const fcmDetail = details.find((x) => String(x['@type']).includes('FcmError'));
    writeOne(
      'messaging-web-token-rotation',
      ['messaging#20'],
      'Registration-token rotation across push-subscription lifecycle change: modular firebase/messaging and firebase/messaging/sw expose no onTokenRefresh callback, unsubscribing the underlying PushSubscription and calling getToken again revokes the prior registration and mints a new token that receives foreground deliveries, and FCM v1 messages:send eventually rejects the rotated-away prior token with 404 NOT_FOUND / UNREGISTERED.',
      {
        clientHasOnTokenRefresh: r.clientHasOnTokenRefresh,
        swHasOnTokenRefresh: r.swHasOnTokenRefresh,
        pushSubscriptionUnsubscribed: r.pushSubscriptionUnsubscribed,
        rotatedTokenMinted: r.rotatedTokenMinted,
        tokenChangedOnRotation: r.tokenChangedOnRotation,
        rotatedTokenSameShapeLength: r.rotatedTokenSameShapeLength,
        rotatedTokenDeliversForeground: r.rotatedTokenDeliversForeground,
        firstSendToPriorTokenStatus: r.firstSendToPriorTokenStatus,
        priorTokenEventuallyUnregistered: r.priorTokenUnregistered !== null,
        priorTokenUnregisteredHttpStatus: r.priorTokenUnregistered?.status ?? null,
        priorTokenUnregisteredErrorStatus: err.status ?? null,
        priorTokenFcmErrorCode: fcmDetail?.errorCode ?? null,
        noDeliveryFromPriorToken: r.noDeliveryFromPriorToken,
      },
      { fbSdkVersion, adminSdkVersion },
    );
  }

  if (results.offlineStoreAndForward) {
    const o = results.offlineStoreAndForward;
    writeOne(
      'messaging-web-offline-store-and-forward',
      ['messaging-admin#42'],
      'Offline store-and-forward Web Push delivery across persistent Chromium restart: while the browser GCM channel is closed, FCM buffers non-collapsible messages within TTL for delivery on reconnect, collapses pending messages sharing webpush.headers.Topic / collapseKey so the newer replaces the older, and drops messages whose short TTL expires before reconnect.',
      {
        onlineBaselineDelivered: o.onlineBaselineDelivered,
        tokenPreservedAcrossOfflineRestart: o.tokenPreservedAcrossOfflineRestart,
        nonCollapsibleQueuedDeliveredOnReconnect: o.nonCollapsibleQueuedDeliveredOnReconnect,
        collapsibleFirstDelivered: o.collapsibleFirstDelivered,
        collapsibleSecondDelivered: o.collapsibleSecondDelivered,
        collapsibleReplacedOlderPending: o.collapsibleReplacedOlderPending,
        expiredShortTtlDelivered: o.expiredShortTtlDelivered,
        expiredShortTtlDroppedBeforeReconnect: o.expiredShortTtlDroppedBeforeReconnect,
        cleanupTokenDeletedTruthy: o.cleanupTokenDeletedTruthy,
      },
      { fbSdkVersion, adminSdkVersion },
    );
  }

  if (results.deleteToken) {
    const d = results.deleteToken;
    const err = d.unregistered?.error ?? {};
    const details = (err.details as Array<Record<string, unknown>> | undefined) ?? [];
    const fcmDetail = details.find((x) => String(x['@type']).includes('FcmError'));
    writeOne(
      'messaging-web-deletetoken-unregistered',
      ['messaging#3'],
      'deleteToken(messaging) then a server send to the now-deleted token. Stable facts (pinned): the v1 messages:send plane eventually returns the UNREGISTERED/404-class google.rpc envelope (HTTP 404, status NOT_FOUND, details carry google.firebase.fcm.v1.FcmError with errorCode UNREGISTERED); and no delivery reaches the client on either route.',
      {
        deleteTokenResolvedTruthy: d.deleteResolvedTruthy,
        sendPlaneEventuallyUnregistered: d.unregistered !== null,
        unregisteredHttpStatus: d.unregistered?.status ?? null,
        unregisteredErrorStatus: err.status ?? null,
        unregisteredErrorCodeTop: err.code ?? null,
        unregisteredMessagePresent: typeof err.message === 'string' && err.message.length > 0,
        unregisteredDetailTypes: details.map((x) => x['@type']),
        fcmErrorCode: fcmDetail?.errorCode ?? null,
        adminSendThrows: d.adminThrow !== null,
        adminThrowCode: d.adminThrow?.code ?? null,
        firstSendStatus: d.firstSendStatus,
        noDeliveryToClient: d.noDeliveryToClient,
      },
      { fbSdkVersion, adminSdkVersion },
    );
  }

  return written;
}
