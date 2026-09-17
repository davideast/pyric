/**
 * The sandbox messaging broker — the ONE in-process FCM model every plane
 * consumes:
 *
 *   - the client mirror (`pyric/messaging`) mints/deletes tokens and
 *     registers FOREGROUND handlers;
 *   - the sw mirror (`pyric/messaging/sw`) registers BACKGROUND handlers;
 *   - the admin mirror (`pyric-admin/messaging`) drives message intake
 *     (send / sendEach / topic management) via `pyric/messaging/internal`;
 *   - Pyric Studio & tracing consume the typed `service_mutation` events
 *     the broker emits onto the sandbox's unified `onEvent` stream —
 *     tracing is a CONSUMER of the stream, never a parallel log.
 *
 * Hosted and SharedWorker transports use the same broker. Token ownership,
 * window visibility, and observers are grouped by recipient (installation,
 * Firebase app, and Service Worker scope). Headless mirrors use one default
 * recipient; transports supply explicit recipient identities.
 */
import type { Sandbox } from '../../sandbox/types/service.js';
import type { AuthState } from '../../sandbox/types/auth-state.js';
import { emitSandboxEvent, makeServiceMutationEvent } from '../../sandbox/internal/sandbox-impl.js';
import type { MessagingEventOperation } from '../events.js';
import { deliveryHistory } from './delivery-history.js';
import { getClock } from '../../sandbox/clock.js';
import { BrokerSendError, unregisteredTokenEnvelope, invalidTopicNameEnvelope } from './envelopes.js';
import { isMessagingSnapshot, type MessagingSnapshot, type TokenRecord } from './persistence.js';
import { mintToken } from './tokens.js';
import { validateMessage, isValidTopicName, canonicalTopicName, TOKEN_SHAPE_RE } from './validate.js';
import type {
  AcceptedSend,
  BrokerMessage,
  ClientVisibilityState,
  DeliveredPayload,
  DeliveryLogEntry,
  DeliveryStage,
  DeliveryResult,
  DeliveryRoute,
  MessagingBrokerConfig,
  PayloadHandler,
  RegisteredToken,
  ResolvedTarget,
  TopicManagementOutcome,
} from './types.js';

/** Default project id for sandbox-minted message resource names. */
export const DEFAULT_PROJECT_ID = 'pyric-sandbox';
/**
 * Default sender id (the `from` value on delivered payloads). A fixed
 * 12-digit numeric string in the project-number shape production uses;
 * `fromEqualsSenderId` is pinned by the receive-plane captures.
 */
export const DEFAULT_SENDER_ID = '999999999999';

/** The id the mirrors use for the single simulated window client. */
export const DEFAULT_CLIENT_ID = 'window-default';

const DEFAULT_RECIPIENT = 'sandbox-default';

/** Ops run on the admin/send plane or the SDK control plane — never a rules identity. */
const ADMIN_AUTH: AuthState = null;

export class MessagingBroker {
  readonly projectId: string;
  readonly senderId: string;

  private readonly sandbox: Sandbox | undefined;
  /** registrationId → active token (stability per registration is the captured contract). */
  private readonly registrations = new Map<string, string>();
  /** token → record. Deleted tokens stay, flipped to `unregistered`, so dead sends 404. */
  private readonly tokenRecords = new Map<string, TokenRecord>();
  /** topic → subscribed tokens. */
  private readonly subscriptions = new Map<string, Set<string>>();
  /** Window clients and their visibility — THE routing input (never focus). */
  private readonly clients = new Map<string, { state: ClientVisibilityState; recipientId: string }>();
  private readonly foregroundHandlers = new Map<PayloadHandler, string>();
  private readonly backgroundHandlers = new Map<PayloadHandler, string>();
  private numericIdCounter = 0;
  private readonly changeListeners = new Set<() => void>();

  constructor(options: MessagingBrokerConfig & { sandbox?: Sandbox } = {}) {
    this.projectId = options.projectId ?? DEFAULT_PROJECT_ID;
    this.senderId = options.senderId ?? DEFAULT_SENDER_ID;
    this.sandbox = options.sandbox;
  }

  /** Durable token state only; live browser connections are restored by their clients. */
  snapshot(): MessagingSnapshot {
    return {
      version: 1,
      tokens: [...this.tokenRecords].map(([token, record]) => [token, { ...record }]),
      topics: [...this.subscriptions].map(([topic, tokens]) => [topic, [...tokens]]),
    };
  }

  restore(data: unknown): void {
    if (!isMessagingSnapshot(data)) throw new Error('Invalid Messaging persistence snapshot.');
    this.registrations.clear();
    this.tokenRecords.clear();
    this.subscriptions.clear();
    for (const [token, record] of data.tokens) {
      this.tokenRecords.set(token, { ...record });
      const isActive = record.state === 'active';
      if (isActive) this.registrations.set(record.registrationId, token);
    }
    for (const [topic, tokens] of data.topics) this.subscriptions.set(topic, new Set(tokens));
  }

  reset(): void {
    this.registrations.clear();
    this.tokenRecords.clear();
    this.subscriptions.clear();
    this.changed();
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  // ── Token lifecycle ───────────────────────────────────────────────────────

  /**
   * Return the registration's token, minting on first call. Stable across
   * calls for the same registration (oracle: `messaging-web-token-stability`);
   * shape class per `mintToken` (oracle: `messaging-web-token-shape`).
   */
  getTokenFor(registrationId: string, recipientId = DEFAULT_RECIPIENT): string {
    const existing = this.registrations.get(registrationId);
    if (existing !== undefined) return existing;
    const token = mintToken();
    this.registrations.set(registrationId, token);
    this.tokenRecords.set(token, { registrationId, recipientId, state: 'active' });
    this.changed();
    this.emit('token_minted', { path: token, detail: { registrationId } });
    return token;
  }

  /**
   * Invalidate the registration's token. Resolves truthy whether or not a
   * token existed (oracle: `messaging-web-deletetoken-unregistered`
   * `deleteTokenResolvedTruthy`). After deletion the token routes NO client
   * delivery and the send plane answers with the captured UNREGISTERED
   * envelope. Deliberate divergence from production's TIMING nuance: prod
   * propagates unregistration asynchronously (a first send after delete was
   * observed accepted once); the broker is deterministic — dead is dead
   * immediately. The observation pins that nuance as environment-dependent
   * and NOT contractual.
   */
  deleteTokenFor(registrationId: string): boolean {
    const token = this.registrations.get(registrationId);
    if (token === undefined) return true;
    this.registrations.delete(registrationId);
    const record = this.tokenRecords.get(token);
    if (record !== undefined) record.state = 'unregistered';
    this.changed();
    this.emit('token_deleted', { path: token, detail: { registrationId } });
    return true;
  }

  /** `active` | `unregistered` (minted then deleted) | `unknown` (never minted here). */
  tokenState(token: string): 'active' | 'unregistered' | 'unknown' {
    return this.tokenRecords.get(token)?.state ?? 'unknown';
  }

  // ── Topic / condition subscriptions ──────────────────────────────────────

  /**
   * Subscribe tokens to a topic. Topic names validate against the captured
   * `[a-zA-Z0-9-_.~%]` charset (a `/topics/` prefix is accepted and
   * stripped, mirroring the admin SDK). Per-token outcomes:
   *   - shape-invalid token       → error entry `invalid-token`
   *   - minted-then-deleted token → error entry `unregistered-token`
   *   - well-formed unknown token → SUCCESS (UNOBSERVED: production accepts
   *     tokens it did not mint in this project only until IID rejects them;
   *     the broker accepts them so cross-sandbox fixtures compose. Probe
   *     candidate.)
   */
  subscribeToTopic(tokens: readonly string[], topic: string): TopicManagementOutcome {
    return this.mutateSubscriptions(tokens, topic, 'subscribe');
  }

  /** Unsubscribe tokens from a topic. Same validation/outcome model as subscribe. */
  unsubscribeFromTopic(tokens: readonly string[], topic: string): TopicManagementOutcome {
    return this.mutateSubscriptions(tokens, topic, 'unsubscribe');
  }

  private mutateSubscriptions(
    tokens: readonly string[],
    topic: string,
    action: 'subscribe' | 'unsubscribe',
  ): TopicManagementOutcome {
    if (!isValidTopicName(topic)) {
      throw new BrokerSendError(invalidTopicNameEnvelope());
    }
    const name = canonicalTopicName(topic);
    const set = this.subscriptions.get(name) ?? new Set<string>();
    this.subscriptions.set(name, set);

    const outcome: TopicManagementOutcome = { successCount: 0, failureCount: 0, errors: [] };
    tokens.forEach((token, index) => {
      if (!TOKEN_SHAPE_RE.test(token)) {
        outcome.failureCount++;
        outcome.errors.push({ index, reason: 'invalid-token' });
        return;
      }
      if (this.tokenState(token) === 'unregistered') {
        outcome.failureCount++;
        outcome.errors.push({ index, reason: 'unregistered-token' });
        return;
      }
      if (action === 'subscribe') set.add(token);
      else set.delete(token);
      outcome.successCount++;
    });

    this.changed();
    this.emit('subscription_changed', {
      path: name,
      detail: {
        action,
        tokenCount: tokens.length,
        successCount: outcome.successCount,
        failureCount: outcome.failureCount,
      },
    });
    return outcome;
  }

  /** Topics an active token is currently subscribed to (routing input). */
  private topicsOf(token: string): Set<string> {
    const topics = new Set<string>();
    for (const [topic, set] of this.subscriptions) {
      if (set.has(token)) topics.add(topic);
    }
    return topics;
  }

  /**
   * Every device token the broker knows about, minted or merely subscribed,
   * and the topics each is subscribed to (the `tokens` service-tool method's
   * read). A token stays listed after `deleteTokenFor` invalidates it,
   * reported `unregistered`, the same dead-is-dead-immediately contract
   * {@link tokenState} already carries. A token this sandbox never minted but
   * that `subscribeToTopic` accepted anyway is listed `unknown`, because it
   * is genuinely part of the sandbox's subscription state even though this
   * sandbox never issued it.
   */
  tokens(): RegisteredToken[] {
    const known = new Set(this.tokenRecords.keys());
    for (const set of this.subscriptions.values()) {
      for (const token of set) known.add(token);
    }
    return [...known].sort().map((token) => ({
      token,
      state: this.tokenState(token),
      topics: [...this.topicsOf(token)].sort(),
    }));
  }

  // ── Message intake (the admin mirror / future op-channel entry point) ────

  /**
   * Validate and accept a message — the send plane. Throws
   * {@link BrokerSendError} with the exact captured envelope on every
   * rejection; resolves an {@link AcceptedSend} whose `name` is the FCM
   * resource name (`projects/<projectId>/messages/<id>`, numeric id for
   * topic/condition targets, UUID-form for token targets).
   *
   * `validateOnly` (the admin SDK's `dryRun`) runs the IDENTICAL validation
   * path and returns the SAME shape with a fake id (captured:
   * `dryRunSameShapeAsReal` on every accept observation,
   * `realSendEnvelopeIdentical` on every rejection observation). It skips
   * only the delivery side effects.
   */
  send(message: BrokerMessage, options: { validateOnly?: boolean } = {}): AcceptedSend {
    const validateOnly = options.validateOnly === true;
    let target: ResolvedTarget;
    try {
      target = validateMessage(message);
      // A well-formed token that is dead (deleted) or foreign (never minted
      // here) answers with the captured UNREGISTERED envelope. Parity: the
      // dryRun path rejects identically (validate_only parity is pinned).
      if (target.kind === 'token' && this.tokenState(target.token) !== 'active') {
        throw new BrokerSendError(unregisteredTokenEnvelope());
      }
    } catch (error) {
      if (error instanceof BrokerSendError) {
        this.emit('message_rejected', {
          detail: {
            status: error.envelope.status,
            errorStatus: error.envelope.error.status,
            errorCode: error.errorCode,
            message: error.envelope.error.message,
            validateOnly,
          },
        });
      }
      throw error;
    }

    const messageId = target.kind === 'token' ? crypto.randomUUID() : this.mintNumericId();
    const accepted: AcceptedSend = {
      name: `projects/${this.projectId}/messages/${messageId}`,
      messageId,
      target,
      validateOnly,
    };

    this.emit('message_accepted', {
      path: targetPath(target),
      detail: { target: target.kind, name: accepted.name, messageId, validateOnly },
    });

    if (!validateOnly) {
      const payload = this.toPayload(message, messageId);
      for (const recipientId of this.matchingRecipients(target)) this.route(payload, recipientId);
    }
    return accepted;
  }

  /** Numeric message-id mint for topic/condition targets (prod shape: long numeric string). */
  private mintNumericId(): string {
    this.numericIdCounter = (this.numericIdCounter + 1) % 1_000_000;
    return `${Date.now()}${String(this.numericIdCounter).padStart(6, '0')}`;
  }

  private matchingRecipients(target: ResolvedTarget): Set<string> {
    const recipients = new Set<string>();
    for (const [token, record] of this.tokenRecords) {
      const isActive = record.state === 'active';
      if (!isActive) continue;
      let matches: boolean;
      switch (target.kind) {
        case 'token': matches = token === target.token; break;
        case 'topic': matches = this.subscriptions.get(target.topic)?.has(token) === true; break;
        case 'condition': matches = evaluateCondition(target.condition, this.topicsOf(token)); break;
      }
      if (matches) recipients.add(record.recipientId);
    }
    return recipients;
  }

  private toPayload(message: BrokerMessage, messageId: string): DeliveredPayload {
    const payload: DeliveredPayload = { from: this.senderId, messageId };
    if (message.data !== undefined) payload.data = { ...message.data };
    if (message.notification !== undefined) {
      const { title, body, imageUrl } = message.notification;
      payload.notification = {
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(imageUrl !== undefined ? { image: imageUrl } : {}),
      };
    }
    return payload;
  }

  // ── Client plane: visibility state + handler registration + routing ──────

  /**
   * Record a window client's visibility. Mirrors set this (per tab later,
   * one simulated client in the degenerate case) so headless tests can
   * drive both routes.
   */
  setClientVisibility(clientId: string, state: ClientVisibilityState, recipientId = DEFAULT_RECIPIENT): void {
    this.clients.set(clientId, { state, recipientId });
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** Foreground (`onMessage`) handler. Returns an unsubscribe function. */
  onForegroundMessage(handler: PayloadHandler, recipientId = DEFAULT_RECIPIENT): () => void {
    this.foregroundHandlers.set(handler, recipientId);
    return () => this.foregroundHandlers.delete(handler);
  }

  /** Background (`onBackgroundMessage`) handler. Returns an unsubscribe function. */
  onBackgroundMessage(handler: PayloadHandler, recipientId = DEFAULT_RECIPIENT): () => void {
    this.backgroundHandlers.set(handler, recipientId);
    return () => this.backgroundHandlers.delete(handler);
  }

  /**
   * Inject a delivery directly into the client plane (the mirrors'
   * `sandbox.deliver` driver; later the host's `messaging.deliver` op).
   * Builds the captured envelope shape — top-level keys exactly
   * `data`/`from`/`messageId` (+ `notification` unless data-only) — and
   * routes it by the visibility rule.
   */
  deliver(spec: {
    data?: Record<string, string>;
    notification?: { title?: string; body?: string; image?: string };
    from?: string;
    messageId?: string;
  }, recipientId = DEFAULT_RECIPIENT): DeliveryResult {
    const payload: DeliveredPayload = {
      from: spec.from ?? this.senderId,
      messageId: spec.messageId ?? crypto.randomUUID(),
    };
    if (spec.data !== undefined) payload.data = { ...spec.data };
    if (spec.notification !== undefined) payload.notification = { ...spec.notification };
    return this.route(payload, recipientId);
  }

  /**
   * THE captured routing rule (oracle: `messaging-web-visibility-routing`):
   * foreground handlers iff a window of THIS recipient reports `visible`; otherwise
   * background handlers. Visibility, never focus. Routing is exclusive —
   * one route per delivery.
   */
  private route(payload: DeliveredPayload, recipientId: string): DeliveryResult {
    let anyVisible = false;
    for (const client of this.clients.values()) {
      const isVisibleRecipient = client.recipientId === recipientId && client.state === 'visible';
      if (isVisibleRecipient) {
        anyVisible = true;
        break;
      }
    }
    const route: DeliveryRoute = anyVisible ? 'foreground' : 'background';
    const handlers = route === 'foreground' ? this.foregroundHandlers : this.backgroundHandlers;

    this.emit('delivery_routed', {
      detail: { route, recipientId, visibleClient: anyVisible, messageId: payload.messageId },
    });

    let handlerCount = 0;
    for (const [handler, handlerRecipient] of [...handlers]) {
      const isRecipient = handlerRecipient === recipientId;
      if (!isRecipient) continue;
      handlerCount++;
      // Each handler gets its own copy so a mutating consumer can't corrupt
      // its siblings' view of the captured envelope. A throwing handler must
      // not block its siblings — same isolation contract as the auth
      // listener fan-out (test/auth/sandbox-listeners.test.ts).
      try {
        handler(structuredClone(payload));
      } catch {
        // Handler errors are the consumer's problem, never the broker's.
      }
    }

    // The delivery history IS this event. `deliveries` folds the stream back
    // into entries, so everything an entry reports has to ride here.
    this.emit('message_delivered', {
      detail: {
        recipientId,
        route,
        handlerCount,
        handled: handlerCount > 0,
        messageId: payload.messageId,
        payload: structuredClone(payload),
      },
    });
    return { route, handlerCount, payload };
  }

  /**
   * What was delivered, in delivery order: foreground or background, handled
   * or not (the `deliveries` service-tool method's read). Folded out of the
   * sandbox event stream's `message_delivered` events, which are the delivery
   * history; the broker keeps no second copy. `since` is a clock timestamp
   * cursor; entries at or after it are returned. A `send` with no matching
   * recipient never calls {@link route}, so it emits nothing here. Only an
   * actual routing decision does.
   */
  acknowledge(messageId: string, recipientId: string, observerId: string, stage: DeliveryStage): void {
    this.emit('delivery_acknowledged', { detail: { messageId, recipientId, observerId, stage } });
  }

  deliveries(since?: number): DeliveryLogEntry[] {
    return deliveryHistory(this.sandbox?.history() ?? [], since);
  }

  // ── Event emission (Studio stream consumer seam) ──────────────────────────

  /**
   * Land a broker operation on the sandbox's unified event stream.
   * Best-effort, storage-precedent: a throw from the emit path must never
   * fail the messaging operation the caller just completed.
   */
  private emit(op: MessagingEventOperation, fields: { path?: string; detail?: Record<string, unknown> }): void {
    if (this.sandbox === undefined) return;
    try {
      emitSandboxEvent(
        this.sandbox,
        makeServiceMutationEvent({
          at: getClock(this.sandbox).now(),
          service: 'messaging',
          op,
          auth: ADMIN_AUTH,
          ...fields,
        }),
        { service: 'messaging' },
      );
    } catch {
      // Observational — never let event emission break a messaging op.
    }
  }
}

function targetPath(target: ResolvedTarget): string {
  if (target.kind === 'token') return target.token;
  if (target.kind === 'topic') return target.topic;
  return target.condition;
}

/**
 * Evaluate a (pre-validated) condition against a token's topic set. Re-uses
 * the same grammar as `parseCondition`; kept here because evaluation is a
 * routing concern, not a validation concern.
 */
export function evaluateCondition(condition: string, topics: ReadonlySet<string>): boolean {
  const src = condition;
  let pos = 0;

  function ws(): void {
    while (pos < src.length && /\s/.test(src[pos]!)) pos++;
  }
  function lit(s: string): boolean {
    ws();
    if (src.startsWith(s, pos)) {
      pos += s.length;
      return true;
    }
    return false;
  }
  function primary(): boolean {
    ws();
    if (lit('!')) return !primary();
    if (lit('(')) {
      const v = expr();
      lit(')');
      return v;
    }
    ws();
    pos++; // opening quote (validated upstream)
    const start = pos;
    while (pos < src.length && src[pos] !== "'") pos++;
    const name = src.slice(start, pos);
    pos++; // closing quote
    lit('in');
    lit('topics');
    return topics.has(name);
  }
  function expr(): boolean {
    let value = primary();
    for (;;) {
      ws();
      if (lit('&&')) {
        const rhs = primary();
        value = value && rhs;
        continue;
      }
      if (lit('||')) {
        const rhs = primary();
        value = value || rhs;
        continue;
      }
      return value;
    }
  }
  return expr();
}
