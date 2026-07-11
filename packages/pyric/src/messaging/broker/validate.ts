/**
 * Send-plane intake validation — the CAPTURED contract, in checking order.
 *
 * Each rule cites the observation that pins it. Rules with no observation
 * are marked UNOBSERVED and stated at documentation strength (probe
 * candidates before they can be trusted as prod-faithful).
 *
 * CHECK ORDER (provisional — every captured case is single-fault, so
 * production's precedence among simultaneous faults is unobserved):
 *   1. target exclusivity (exactly one of token / topic / condition)
 *   2. per-target syntax (token shape, topic charset, condition grammar)
 *   3. webpush headers.TTL
 *   4. data payload size boundary
 */
import {
  BrokerSendError,
  invalidConditionEnvelope,
  invalidTokenEnvelope,
  invalidTopicNameEnvelope,
  invalidWebpushTtlEnvelope,
  multipleTargetsEnvelope,
  noTargetEnvelope,
  oversizedPayloadEnvelope,
} from './envelopes.js';
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
 * `'not-a-valid-fcm-token'` — no colon — was driven); this class is the
 * broker's provisional model.
 */
export const TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/**
 * The EMPIRICAL data-payload enforcement boundary.
 *
 * oracle: `messaging-send-oversized-payload-error-envelope` bisected a
 * minimal single-entry topic message (`data: { p: 'x'.repeat(len) }`):
 * len 4505 accepted, 4506 rejected. Under the broker's size model —
 * summed UTF-8 bytes of every data key + value — the flip sits at
 * 1 ('p') + 4505 = 4506 bytes accepted, 4507 rejected. The documented cap
 * (4096, quoted in the error message) is NOT the enforcement constant;
 * production enforces looser. The true production size function is
 * unobserved beyond this one point — this model reproduces the captured
 * boundary exactly for the captured probe shape and is a provisional
 * design decision (see the broker report; informs the open payload-size
 * ticket).
 */
export const EMPIRICAL_DATA_CAP_BYTES = 4506;

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
  return topic.startsWith('/topics/') ? topic.slice('/topics/'.length) : topic;
}

export function isValidTopicName(topic: string): boolean {
  const name = canonicalTopicName(topic);
  return name.length > 0 && TOPIC_NAME_RE.test(name);
}

/**
 * Condition grammar: boolean expressions over `'name' in topics` with
 * `&&`, `||`, `!`, and parentheses. A dangling operator (the captured
 * malformed case `"'a' in topics &&"`) fails the parse and produces the
 * captured BARE envelope. UNOBSERVED: production's documented 5-topic
 * limit per condition is not enforced here (no captured envelope for it).
 *
 * Returns the topic names referenced (for delivery routing) or `null`
 * when the condition is malformed.
 */
export function parseCondition(condition: string): { topics: string[] } | null {
  const src = condition;
  let pos = 0;
  const topics: string[] = [];

  function ws(): void {
    while (pos < src.length && /\s/.test(src[pos]!)) pos++;
  }

  function expectLiteral(lit: string): boolean {
    ws();
    if (src.startsWith(lit, pos)) {
      pos += lit.length;
      return true;
    }
    return false;
  }

  // primary := "'" name "' in topics" | "(" expr ")" | "!" primary
  function primary(): boolean {
    ws();
    if (expectLiteral('!')) return primary();
    if (expectLiteral('(')) {
      if (!expr()) return false;
      return expectLiteral(')');
    }
    ws();
    if (src[pos] !== "'") return false;
    pos++;
    const start = pos;
    while (pos < src.length && src[pos] !== "'") pos++;
    if (pos >= src.length) return false;
    const name = src.slice(start, pos);
    pos++; // closing quote
    if (!expectLiteral('in')) return false;
    if (!expectLiteral('topics')) return false;
    if (!isValidTopicName(name)) return false;
    topics.push(name);
    return true;
  }

  // expr := primary (('&&' | '||') primary)*
  function expr(): boolean {
    if (!primary()) return false;
    for (;;) {
      ws();
      if (expectLiteral('&&') || expectLiteral('||')) {
        if (!primary()) return false;
        continue;
      }
      return true;
    }
  }

  if (!expr()) return null;
  ws();
  if (pos !== src.length) return null;
  return { topics };
}

/**
 * Validate an intake message against the captured contract and resolve its
 * target. Throws {@link BrokerSendError} carrying the exact captured
 * envelope for each fault; returns the resolved target on acceptance.
 * `validate_only` (dryRun) runs this identical path — parity is pinned by
 * every `realSendEnvelopeIdentical` capture.
 */
export function validateMessage(message: BrokerMessage): ResolvedTarget {
  if (typeof message !== 'object' || message === null) {
    throw new BrokerSendError(noTargetEnvelope());
  }

  // 1. Target exclusivity (oracle: messaging-send-no-target-error-envelope).
  const targets: ResolvedTarget[] = [];
  if (typeof message.token === 'string') targets.push({ kind: 'token', token: message.token });
  if (typeof message.topic === 'string') {
    targets.push({ kind: 'topic', topic: canonicalTopicName(message.topic) });
  }
  if (typeof message.condition === 'string') {
    targets.push({ kind: 'condition', condition: message.condition, topics: [] });
  }
  if (targets.length === 0) throw new BrokerSendError(noTargetEnvelope());
  if (targets.length > 1) throw new BrokerSendError(multipleTargetsEnvelope());
  const target = targets[0]!;

  // 2. Per-target syntax.
  if (target.kind === 'token' && !TOKEN_SHAPE_RE.test(target.token)) {
    // oracle: messaging-send-invalid-token-error-envelope
    throw new BrokerSendError(invalidTokenEnvelope());
  }
  if (target.kind === 'topic' && !isValidTopicName(target.topic)) {
    // oracle: messaging-send-invalid-topic-name-error-envelope
    throw new BrokerSendError(invalidTopicNameEnvelope());
  }
  if (target.kind === 'condition') {
    // oracle: messaging-send-invalid-condition-error-envelope (bare envelope)
    const parsed = parseCondition(target.condition);
    if (parsed === null) throw new BrokerSendError(invalidConditionEnvelope());
    target.topics = parsed.topics;
  }

  // 3. webpush headers.TTL (oracle: messaging-send-webpush-invalid-ttl-error-envelope).
  const ttl = message.webpush?.headers?.TTL;
  if (ttl !== undefined && !/^\d+$/.test(String(ttl))) {
    throw new BrokerSendError(invalidWebpushTtlEnvelope());
  }

  // 4. Data payload boundary (oracle: messaging-send-oversized-payload-error-envelope).
  if (dataBytes(message.data) > EMPIRICAL_DATA_CAP_BYTES) {
    throw new BrokerSendError(oversizedPayloadEnvelope());
  }

  return target;
}
