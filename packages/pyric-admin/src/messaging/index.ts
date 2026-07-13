/**
 * `pyric-admin/messaging` — the `firebase-admin/messaging` send-plane mirror
 * (surface `messaging-admin`, rows `messaging-admin#1`–`#39` in
 * `packages/conformance/registry/messaging.ts`).
 *
 * A sandbox-branded app produces an in-process {@link Messaging} over the
 * per-sandbox {@link MessagingBroker} from `pyric/messaging/internal`.
 * Sharing the `Sandbox` with the client mirrors closes the loop: `send()`
 * here routes deliveries into `pyric/messaging`'s `onMessage` /
 * `pyric/messaging/sw`'s `onBackgroundMessage` by the captured visibility
 * rule.
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
 * degenerate case. Outside the climb it preserves the captured no-app error.
 *
 * Mirror-owned `FirebaseMessagingError` and `MessagingClientErrorCode`
 * preserve the observable names, codes, and static members used by callers.
 */

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
  type PyricAdminApp,
  type SandboxAdminApp,
} from '../app/index.js';

type ErrorCodeInfo = { code: string; message: string };
export class MessagingClientErrorCode {
  static readonly INVALID_ARGUMENT = {
    code: 'invalid-argument',
    message: 'Invalid argument provided.',
  };
  static readonly INVALID_REGISTRATION_TOKEN = {
    code: 'invalid-registration-token',
    message: 'Invalid registration token provided.',
  };
  static readonly REGISTRATION_TOKEN_NOT_REGISTERED = {
    code: 'registration-token-not-registered',
    message: 'The provided registration token is not registered.',
  };
}

export class FirebaseMessagingError extends Error {
  readonly code: string;

  constructor(info: ErrorCodeInfo, message?: string) {
    super(message ?? info.message);
    this.name = 'FirebaseMessagingError';
    this.code = `messaging/${info.code}`;
  }
}

const MessagingError = FirebaseMessagingError;
const ErrorCodes = MessagingClientErrorCode as unknown as Record<string, ErrorCodeInfo>;

/** Mirror-owned structural messaging types. */
export type Notification = NonNullable<BrokerMessage['notification']>;
export type FcmOptions = NonNullable<BrokerMessage['fcmOptions']>;
export type WebpushConfig = NonNullable<BrokerMessage['webpush']>;
export type WebpushFcmOptions = NonNullable<WebpushConfig['fcmOptions']>;
export type WebpushNotification = Record<string, unknown>;
export type ApnsConfig = Record<string, unknown>;
export type ApnsPayload = Record<string, unknown>;
export type Aps = Record<string, unknown>;
export type ApsAlert = string | Record<string, unknown>;
export type CriticalSound = Record<string, unknown>;
export type ApnsFcmOptions = Record<string, unknown>;
export type AndroidConfig = Record<string, unknown>;
export type AndroidNotification = Record<string, unknown>;
export type LightSettings = Record<string, unknown>;
export type AndroidFcmOptions = Record<string, unknown>;
export type DataMessagePayload = Record<string, string>;
export type NotificationMessagePayload = Record<string, string>;
export type MessagingPayload = Record<string, unknown>;
export type MessagingOptions = Record<string, unknown>;

export interface BaseMessage extends Omit<BrokerMessage, 'token' | 'topic' | 'condition'> {}
export interface TokenMessage extends BaseMessage { token: string }
export interface TopicMessage extends BaseMessage { topic: string }
export interface ConditionMessage extends BaseMessage { condition: string }
export type Message = TokenMessage | TopicMessage | ConditionMessage;
export interface MulticastMessage extends BaseMessage { tokens: string[] }
export interface SendResponse { success: boolean; messageId?: string; error?: FirebaseMessagingError }
export interface BatchResponse { responses: SendResponse[]; successCount: number; failureCount: number }
export interface MessagingTopicManagementResponse {
  successCount: number;
  failureCount: number;
  errors: Array<{ index: number; error: FirebaseMessagingError }>;
}

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
 * The sandbox `Messaging` service mirror, implementing the send plane over
 * the broker.
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
 * Return the broker-backed `Messaging` service for the default or given
 * sandbox admin app.
 */
export function getMessaging(app?: PyricAdminApp): Messaging {
  const resolved = resolveApp(app);
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
