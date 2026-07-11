/**
 * `pyric-admin/messaging` — the `firebase-admin/messaging` send-plane mirror
 * (surface `messaging-admin`, rows `messaging-admin#1`–`#39` in
 * `scripts/compat/registry/messaging.ts`).
 *
 * Backend dispatch on the `pyric-admin/app` brand, exactly like
 * `pyric-admin/storage`:
 *
 *   - **Prod app** → delegates to `firebase-admin/messaging`'s
 *     `getMessaging(adminApp)` — the genuine production `Messaging`.
 *   - **Sandbox app** → an in-process {@link Messaging} over the
 *     per-sandbox {@link MessagingBroker} from `pyric/messaging/internal`.
 *     Sharing the `Sandbox` with the client mirrors closes the loop:
 *     `send()` here routes deliveries into `pyric/messaging`'s `onMessage`
 *     / `pyric/messaging/sw`'s `onBackgroundMessage` by the captured
 *     visibility rule.
 *
 * Rejections carry the broker's captured `google.rpc` envelopes and are
 * re-wrapped here the way firebase-admin wraps the wire: the FcmError
 * `errorCode` maps through {@link MessagingClientErrorCode}
 * (`INVALID_ARGUMENT` → `messaging/invalid-argument`, `UNREGISTERED` →
 * `messaging/registration-token-not-registered` — the captured
 * `adminThrowCode`), with the envelope's message text.
 *
 * ── Default app (climb-gated) ───────────────────────────────────────────────
 * `getMessaging()` with no app first resolves the registered `'[DEFAULT]'`
 * app (mirroring firebase-admin, including the exact `app/no-app` throw).
 * Only when NO default exists AND `PYRIC_CLIMB=1` does the mirror mint an
 * implicit, UNREGISTERED sandbox app — the conformance suites' headless
 * degenerate case. Outside the climb the behavior is byte-for-byte
 * firebase-admin's.
 *
 * Error classes are firebase-admin's OWN exports (`FirebaseMessagingError`,
 * `MessagingClientErrorCode`), re-exported so `instanceof`, `.code`, and
 * static members match production exactly (the `FirebaseAppError` precedent
 * in `pyric-admin/app`).
 */

import {
  getMessaging as getProdMessaging,
  FirebaseMessagingError,
  MessagingClientErrorCode,
} from 'firebase-admin/messaging';
import type {
  BatchResponse,
  MessagingTopicManagementResponse,
  Message,
  MulticastMessage,
  SendResponse,
} from 'firebase-admin/messaging';

import { initializeSandbox } from 'pyric/sandbox';
import {
  getMessagingBroker,
  BrokerSendError,
  type BrokerMessage,
  type MessagingBroker,
  type TopicManagementOutcome,
} from 'pyric/messaging/internal';

import {
  ADMIN_APP_TARGET,
  getApp,
  isProdAdminApp,
  type PyricAdminApp,
  type SandboxAdminApp,
} from '../app/index.js';

// ── Upstream error surface, re-exported verbatim ────────────────────────────

export { FirebaseMessagingError, MessagingClientErrorCode };

// ── Upstream message/option/response types, re-exported verbatim ───────────
// (rows messaging-admin#10–#37 are type-parity rows; re-exporting
// firebase-admin's own declarations makes the tier-2 assignability census
// trivially exact for the admin plane.)
export type {
  BaseMessage,
  Message,
  TokenMessage,
  TopicMessage,
  ConditionMessage,
  MulticastMessage,
  Notification,
  FcmOptions,
  WebpushConfig,
  WebpushFcmOptions,
  WebpushNotification,
  ApnsConfig,
  ApnsPayload,
  Aps,
  ApsAlert,
  CriticalSound,
  ApnsFcmOptions,
  AndroidConfig,
  AndroidNotification,
  LightSettings,
  AndroidFcmOptions,
  DataMessagePayload,
  NotificationMessagePayload,
  MessagingPayload,
  MessagingOptions,
  MessagingTopicManagementResponse,
  BatchResponse,
  SendResponse,
} from 'firebase-admin/messaging';

/**
 * firebase-admin's published typings hide the error constructor; the runtime
 * class takes `(info, message?)` where `info` is a `MessagingClientErrorCode`
 * static. Same recovery cast as `pyric-admin/app`'s `FirebaseAppError`.
 */
const MessagingError = FirebaseMessagingError as unknown as new (
  info: { code: string; message: string },
  message?: string,
) => Error & { readonly code: string };

type ErrorCodeInfo = { code: string; message: string };
const ErrorCodes = MessagingClientErrorCode as unknown as Record<string, ErrorCodeInfo>;

/** Wire FcmError errorCode → firebase-admin client error info. */
function clientErrorInfoFor(fcmErrorCode: string | undefined): ErrorCodeInfo {
  if (fcmErrorCode === 'UNREGISTERED') return ErrorCodes.REGISTRATION_TOKEN_NOT_REGISTERED!;
  return ErrorCodes.INVALID_ARGUMENT!;
}

/** Re-wrap a broker rejection exactly as firebase-admin wraps the wire envelope. */
function rethrowWrapped(error: unknown): never {
  if (error instanceof BrokerSendError) {
    throw new MessagingError(clientErrorInfoFor(error.errorCode), error.envelope.error.message);
  }
  throw error;
}

function invalidArgument(message: string): Error & { readonly code: string } {
  return new MessagingError(ErrorCodes.INVALID_ARGUMENT!, message);
}

// ── The sandbox Messaging service ────────────────────────────────────────────

/**
 * The `Messaging` service mirror. On the prod path the returned object is
 * literally `firebase-admin/messaging`'s `Messaging`; this class is the
 * sandbox arm, implementing the send plane over the broker.
 */
export class Messaging {
  private readonly broker: MessagingBroker;
  private readonly boundApp: PyricAdminApp;

  constructor(app: SandboxAdminApp) {
    this.boundApp = app;
    this.broker = getMessagingBroker(app.sandbox);
  }

  /** The app this `Messaging` instance is bound to (upstream `get app(): App`). */
  get app(): PyricAdminApp {
    return this.boundApp;
  }

  /**
   * Send one message. Resolves the FCM resource name
   * `projects/<projectId>/messages/<id>` — numeric id for topic/condition
   * targets, UUID-form for token targets. `dryRun` validates on the
   * identical path and returns the SAME shape with a fake id (captured
   * `dryRunSameShapeAsReal` / `realSendEnvelopeIdentical` parity).
   */
  async send(message: Message, dryRun?: boolean): Promise<string> {
    try {
      return this.broker.send(message as BrokerMessage, { validateOnly: dryRun === true }).name;
    } catch (error) {
      rethrowWrapped(error);
    }
  }

  /**
   * Send up to 500 messages; the resolved `BatchResponse.responses` array is
   * ordered to match the input, one entry per message.
   */
  async sendEach(messages: Message[], dryRun?: boolean): Promise<BatchResponse> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw invalidArgument('messages must be a non-empty array');
    }
    if (messages.length > 500) {
      throw invalidArgument('messages list must not contain more than 500 items');
    }
    const responses: SendResponse[] = [];
    for (const message of messages) {
      try {
        const name = this.broker.send(message as BrokerMessage, {
          validateOnly: dryRun === true,
        }).name;
        responses.push({ success: true, messageId: name });
      } catch (error) {
        const wrapped =
          error instanceof BrokerSendError
            ? new MessagingError(clientErrorInfoFor(error.errorCode), error.envelope.error.message)
            : error;
        responses.push({
          success: false,
          error: wrapped as unknown as SendResponse['error'],
        });
      }
    }
    const successCount = responses.filter((r) => r.success).length;
    return { responses, successCount, failureCount: responses.length - successCount };
  }

  /** Fan a `MulticastMessage` (up to 500 tokens) out through {@link sendEach}. */
  async sendEachForMulticast(message: MulticastMessage, dryRun?: boolean): Promise<BatchResponse> {
    if (!Array.isArray(message?.tokens) || message.tokens.length === 0) {
      throw invalidArgument('tokens must be a non-empty array');
    }
    if (message.tokens.length > 500) {
      throw invalidArgument('tokens list must not contain more than 500 items');
    }
    const { tokens, ...base } = message;
    return this.sendEach(
      tokens.map((token) => ({ ...base, token }) as Message),
      dryRun,
    );
  }

  /** Subscribe one or many registration tokens to a topic. */
  async subscribeToTopic(
    tokenOrTokens: string | string[],
    topic: string,
  ): Promise<MessagingTopicManagementResponse> {
    return this.manageTopic(tokenOrTokens, topic, 'subscribe');
  }

  /** Unsubscribe one or many registration tokens from a topic. */
  async unsubscribeFromTopic(
    tokenOrTokens: string | string[],
    topic: string,
  ): Promise<MessagingTopicManagementResponse> {
    return this.manageTopic(tokenOrTokens, topic, 'unsubscribe');
  }

  private manageTopic(
    tokenOrTokens: string | string[],
    topic: string,
    action: 'subscribe' | 'unsubscribe',
  ): MessagingTopicManagementResponse {
    const tokens = Array.isArray(tokenOrTokens) ? tokenOrTokens : [tokenOrTokens];
    if (tokens.length === 0) {
      throw invalidArgument('registration token(s) must be a non-empty string or a non-empty array');
    }
    let outcome: TopicManagementOutcome;
    try {
      outcome =
        action === 'subscribe'
          ? this.broker.subscribeToTopic(tokens, topic)
          : this.broker.unsubscribeFromTopic(tokens, topic);
    } catch (error) {
      rethrowWrapped(error);
    }
    return {
      successCount: outcome.successCount,
      failureCount: outcome.failureCount,
      errors: outcome.errors.map(({ index, reason }) => ({
        index,
        error: (reason === 'unregistered-token'
          ? new MessagingError(ErrorCodes.REGISTRATION_TOKEN_NOT_REGISTERED!)
          : new MessagingError(
              ErrorCodes.INVALID_REGISTRATION_TOKEN ?? ErrorCodes.INVALID_ARGUMENT!,
            )) as unknown as MessagingTopicManagementResponse['errors'][number]['error'],
      })),
    };
  }

  /**
   * Force HTTP/1.1 for batch sends — deprecated upstream; the sandbox has
   * no HTTP transport, so this is a recorded no-op.
   */
  enableLegacyHttpTransport(): void {
    // No transport to reconfigure in the sandbox.
  }
}

// ── Dispatch + default-app resolution ────────────────────────────────────────

const sandboxInstances = new WeakMap<PyricAdminApp, Messaging>();

/**
 * The implicit conformance-climb app: minted only under `PYRIC_CLIMB=1`
 * when no `'[DEFAULT]'` app is registered, and deliberately NOT placed in
 * the app registry (so `getApps()` and later `initializeApp()` calls are
 * unaffected by the WIP messaging surface).
 */
let climbDefaultApp: SandboxAdminApp | null = null;

function resolveApp(app?: PyricAdminApp): PyricAdminApp {
  if (app !== undefined) return app;
  try {
    return getApp();
  } catch (error) {
    if (process.env.PYRIC_CLIMB === '1') {
      climbDefaultApp ??= {
        [ADMIN_APP_TARGET]: 'sandbox',
        sandbox: initializeSandbox(),
        name: '[pyric-messaging-climb]',
      };
      return climbDefaultApp;
    }
    throw error; // firebase-admin's exact app/no-app
  }
}

/**
 * Return the `Messaging` service for the default or given admin app.
 * Prod apps get the genuine `firebase-admin/messaging` service; sandbox
 * apps get the broker-backed mirror.
 */
export function getMessaging(app?: PyricAdminApp): Messaging {
  const resolved = resolveApp(app);
  if (isProdAdminApp(resolved)) {
    return getProdMessaging(resolved.adminApp) as unknown as Messaging;
  }
  const existing = sandboxInstances.get(resolved);
  if (existing !== undefined) return existing;
  const instance = new Messaging(resolved);
  sandboxInstances.set(resolved, instance);
  return instance;
}

/**
 * Namespaced / legacy accessor — the `admin.messaging(app?)` equivalent of
 * {@link getMessaging}.
 */
export function messaging(app?: PyricAdminApp): Messaging {
  return getMessaging(app);
}
