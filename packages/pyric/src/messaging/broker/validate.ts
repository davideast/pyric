/**
 * Send-plane intake validation -- the CAPTURED contract, in checking order.
 *
 * Each rule cites the observation that pins it. Rules with no observation
 * are marked UNOBSERVED and stated at documentation strength (probe
 * candidates before they can be trusted as prod-faithful).
 *
 * CHECK ORDER:
 *   1. client preflight (`validateClientMessage`: `INVALID_PAYLOAD` checks for
 *      message container, present-but-empty/non-string sole target, malformed
 *      `/topics/` or `/` topic prefixes, and payload option blocks)
 *   2. wire target exclusivity (`noTargetEnvelope`, `multipleTargetsEnvelope`)
 *   3. wire target syntax (bare topic charset, token shape, condition grammar)
 *   4. wire `webpush.headers.TTL` integer digits & data payload size boundary
 */
import {
  BrokerSendError,
  invalidConditionEnvelope,
  invalidPayloadEnvelope,
  invalidTokenEnvelope,
  invalidTopicNameEnvelope,
  invalidWebpushTtlEnvelope,
  multipleTargetsEnvelope,
  noTargetEnvelope,
  oversizedPayloadEnvelope,
} from './envelopes.js';
import { isNonNullPlainObject, validateMessagePayloadFields } from './payload-validation.js';
import type { BrokerMessage, ResolvedTarget } from './types.js';

/**
 * The documented FCM topic-name character set
 * (oracle: `messaging-send-invalid-topic-name-error-envelope` pins the
 * rejection of characters outside `[a-zA-Z0-9-_.~%]`).
 */
export const TOPIC_NAME_RE = /^[a-zA-Z0-9-_.~%]+$/;

/**
 * Registration-token shape class, as minted by production and captured in
 * `messaging-web-token-shape`: colon-separated, URL-safe. The broker treats
 * "two non-empty URL-safe segments around a single colon" as well-formed;
 * anything else is the captured invalid-token rejection. UNOBSERVED nuance:
 * production's exact syntactic acceptance set is unknown (only
 * `'not-a-valid-fcm-token'` -- no colon -- was driven); this class is the
 * broker's provisional model.
 */
export const TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/**
 * The EMPIRICAL data-payload enforcement boundary.
 *
 * oracle: `messaging-send-oversized-payload-error-envelope` bisected a
 * minimal single-entry topic message (`data: { p: 'x'.repeat(len) }`)
 * across repeated captures: len 4914 accepted, 4915 rejected.
 * Under the broker's size model -- summed UTF-8 bytes of every data key +
 * value -- the flip sits at 1 ('p') + 4914 = 4915 bytes accepted, 4916
 * rejected. The documented cap (4096, quoted in the error message) is NOT
 * the enforcement constant; production enforces looser.
 */
export const EMPIRICAL_DATA_CAP_BYTES = 4915;

/** Documented FCM limit on topic clauses per condition expression. */
const MAX_CONDITION_TOPICS = 5;

const utf8 = new TextEncoder();

function dataBytes(data: Record<string, string> | undefined): number {
  if (data === undefined) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(data)) {
    total += utf8.encode(key).length + utf8.encode(String(value)).length;
  }
  return total;
}

/** Strip an optional `/topics/` prefix (accepted by the admin SDK) before charset validation. */
export function canonicalTopicName(topic: string): string {
  if (typeof topic !== 'string') return '';
  return topic.startsWith('/topics/') ? topic.slice('/topics/'.length) : topic;
}

function isValidBareTopicName(topic: string): boolean {
  return typeof topic === 'string' && topic.length > 0 && TOPIC_NAME_RE.test(topic);
}

export function isValidTopicName(topic: string): boolean {
  if (typeof topic !== 'string') return false;
  return isValidBareTopicName(canonicalTopicName(topic));
}

function hasMalformedTopicPrefixOrSlash(rawTopic: string, bareTopic: string): boolean {
  return bareTopic.includes('/') || rawTopic.startsWith('/topics/');
}

function isWebpushTtlHeaderName(headerName: string): boolean {
  return headerName.toLowerCase() === 'ttl';
}

function isNonNegativeIntegerDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Condition grammar: boolean expressions over `'name' in topics` with
 * `&&`, `||`, `!`, and parentheses. Keywords `in` and `topics` must be
 * separated by whitespace, and at most five topics may appear in one
 * condition. A malformed condition fails the parse and produces the
 * captured BARE envelope.
 *
 * Returns the topic names referenced (for delivery routing) or `null`
 * when the condition is malformed.
 */
export function parseCondition(condition: string): { topics: string[] } | null {
  const src = condition;
  let pos = 0;
  const topics: string[] = [];

  function ws(): void {
    while (pos < src.length && /\s/.test(src.charAt(pos))) pos++;
  }

  function requireWs(): boolean {
    const start = pos;
    ws();
    return pos > start;
  }

  function expectLiteral(lit: string): boolean {
    ws();
    if (src.startsWith(lit, pos)) {
      pos += lit.length;
      return true;
    }
    return false;
  }

  // primary := "'" name "'" WS "in" WS "topics" | "(" orExpr ")" | "!" primary
  function primary(): boolean {
    ws();
    if (expectLiteral('!')) return primary();
    if (expectLiteral('(')) {
      if (!orExpr()) return false;
      return expectLiteral(')');
    }
    ws();
    if (src.charAt(pos) !== "'") return false;
    pos++;
    const start = pos;
    while (pos < src.length && src.charAt(pos) !== "'") pos++;
    if (pos >= src.length) return false;
    const name = src.slice(start, pos);
    pos++; // closing quote
    if (!requireWs()) return false;
    if (!src.startsWith('in', pos)) return false;
    pos += 'in'.length;
    if (!requireWs()) return false;
    if (!src.startsWith('topics', pos)) return false;
    pos += 'topics'.length;
    if (name.length === 0 || !TOPIC_NAME_RE.test(name)) return false;
    topics.push(name);
    if (topics.length > MAX_CONDITION_TOPICS) return false;
    return true;
  }

  // andExpr := primary ('&&' primary)*
  function andExpr(): boolean {
    if (!primary()) return false;
    for (;;) {
      ws();
      if (expectLiteral('&&')) {
        if (!primary()) return false;
        continue;
      }
      return true;
    }
  }

  // orExpr := andExpr ('||' andExpr)*
  function orExpr(): boolean {
    if (!andExpr()) return false;
    for (;;) {
      ws();
      if (expectLiteral('||')) {
        if (!andExpr()) return false;
        continue;
      }
      return true;
    }
  }

  if (!orExpr()) return null;
  ws();
  if (pos !== src.length) return null;
  return { topics };
}

/**
 * Client-only preflight validation (`INVALID_PAYLOAD` checks enforced by
 * `firebase-admin/messaging` before `dryRun` and before serializing a message
 * over HTTP or a `RemoteSandbox` JSON channel). Wire-level checks (`{}`,
 * multiple targets, bare invalid-char topic, token shape, condition grammar,
 * numeric TTL, and payload byte cap) remain in {@link validateMessage} so
 * `MessagingBroker.send` emits `message_rejected` onto `sandbox.history()`.
 */
export function validateClientMessage(message: BrokerMessage): void {
  const rawMessage: unknown = message;
  if (!isNonNullPlainObject(rawMessage)) {
    throw new BrokerSendError(invalidPayloadEnvelope('Message must be a non-null object'));
  }

  const targetKeys = ['token', 'topic', 'condition'] as const;
  const presentKeys = targetKeys.filter((key) => key in rawMessage);
  const definedKeys = targetKeys.filter((key) => rawMessage[key] !== undefined);
  if (definedKeys.length === 0 && presentKeys.length > 0) {
    throw new BrokerSendError(
      invalidPayloadEnvelope('Exactly one of topic, token or condition is required'),
    );
  }
  if (definedKeys.length === 1) {
    const soleKey = definedKeys[0];
    const rawValue = soleKey !== undefined ? rawMessage[soleKey] : undefined;
    if (typeof rawValue !== 'string' || rawValue.length === 0) {
      throw new BrokerSendError(
        invalidPayloadEnvelope('Exactly one of topic, token or condition is required'),
      );
    }
    if (soleKey === 'topic') {
      const bareTopic = canonicalTopicName(rawValue);
      if (!isValidBareTopicName(bareTopic) && hasMalformedTopicPrefixOrSlash(rawValue, bareTopic)) {
        throw new BrokerSendError(invalidPayloadEnvelope('Malformed topic name'));
      }
    }
  }

  validateMessagePayloadFields(rawMessage);
}

function resolveWireTarget(rawMessage: Record<string, unknown>): ResolvedTarget {
  const targetKeys = ['token', 'topic', 'condition'] as const;
  const definedKeys = targetKeys.filter((key) => rawMessage[key] !== undefined);
  if (definedKeys.length === 0) {
    throw new BrokerSendError(noTargetEnvelope());
  }
  if (definedKeys.length > 1) {
    throw new BrokerSendError(multipleTargetsEnvelope());
  }
  const soleKey = definedKeys[0];
  if (soleKey === undefined) {
    throw new BrokerSendError(noTargetEnvelope());
  }
  const rawValue = String(rawMessage[soleKey]);
  if (soleKey === 'token') {
    return { kind: 'token', token: rawValue };
  }
  if (soleKey === 'topic') {
    return { kind: 'topic', topic: canonicalTopicName(rawValue) };
  }
  return { kind: 'condition', condition: rawValue, topics: [] };
}

/**
 * Validate an intake message against the captured contract and resolve its
 * target. Throws {@link BrokerSendError} carrying the exact captured
 * envelope for each fault; returns the resolved target on acceptance.
 * `validate_only` (dryRun) runs this identical path -- parity is pinned by
 * every `realSendEnvelopeIdentical` capture.
 */
export function validateMessage(message: BrokerMessage): ResolvedTarget {
  validateClientMessage(message);
  const rawMessage = message as unknown as Record<string, unknown>;

  // 1. Wire target exclusivity (oracle: messaging-send-no-target-error-envelope).
  const target = resolveWireTarget(rawMessage);

  // 2. Wire per-target syntax (bare topic charset, token shape, condition grammar).
  if (target.kind === 'topic' && !isValidBareTopicName(target.topic)) {
    // oracle: messaging-send-invalid-topic-name-error-envelope
    throw new BrokerSendError(invalidTopicNameEnvelope());
  }
  if (target.kind === 'token' && !TOKEN_SHAPE_RE.test(target.token)) {
    // oracle: messaging-send-invalid-token-error-envelope
    throw new BrokerSendError(invalidTokenEnvelope());
  }
  if (target.kind === 'condition') {
    // oracle: messaging-send-invalid-condition-error-envelope (bare envelope)
    const parsed = parseCondition(target.condition);
    if (parsed === null) throw new BrokerSendError(invalidConditionEnvelope());
    target.topics = parsed.topics;
  }

  // 3. webpush headers TTL digits (case-insensitive header key; canonical TTL field violation) and data payload byte cap.
  if (message.webpush?.headers !== undefined) {
    for (const [headerName, headerValue] of Object.entries(message.webpush.headers)) {
      if (isWebpushTtlHeaderName(headerName) && !isNonNegativeIntegerDigits(headerValue)) {
        throw new BrokerSendError(invalidWebpushTtlEnvelope());
      }
    }
  }

  if (dataBytes(message.data) > EMPIRICAL_DATA_CAP_BYTES) {
    throw new BrokerSendError(oversizedPayloadEnvelope());
  }

  return target;
}
