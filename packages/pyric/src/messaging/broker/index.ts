/**
 * `pyric/src/messaging/broker` — the sandbox-side FCM broker (see
 * `broker.ts` for the model and the documented worker-host seam).
 *
 * One broker per {@link Sandbox}, held in a WeakMap exactly like
 * `pyric-admin/database`'s per-sandbox state: every plane that shares a
 * Sandbox shares the broker, which is what closes the send→deliver loop
 * in-process (admin `send` on the same sandbox reaches client `onMessage` /
 * sw `onBackgroundMessage` handlers).
 */
import type { Sandbox } from '../../sandbox/types/service.js';
import { MessagingBroker } from './broker.js';
import type { MessagingBrokerConfig } from './types.js';

export {
  MessagingBroker,
  DEFAULT_PROJECT_ID,
  DEFAULT_SENDER_ID,
  DEFAULT_CLIENT_ID,
  evaluateCondition,
} from './broker.js';
export {
  BrokerSendError,
  fcmErrorCodeOf,
  noTargetEnvelope,
  multipleTargetsEnvelope,
  invalidTokenEnvelope,
  invalidTopicNameEnvelope,
  invalidConditionEnvelope,
  oversizedPayloadEnvelope,
  invalidWebpushTtlEnvelope,
  unregisteredTokenEnvelope,
} from './envelopes.js';
export type { FcmErrorEnvelope, ErrorDetail, BadRequestDetail, FcmErrorDetail } from './envelopes.js';
export {
  validateMessage,
  parseCondition,
  isValidTopicName,
  canonicalTopicName,
  TOPIC_NAME_RE,
  TOKEN_SHAPE_RE,
  EMPIRICAL_DATA_CAP_BYTES,
} from './validate.js';
export { mintToken, TOKEN_LENGTH, TOKEN_SUFFIX_PREFIX } from './tokens.js';
export type {
  AcceptedSend,
  BrokerMessage,
  ClientVisibilityState,
  DeliveredPayload,
  DeliveryResult,
  DeliveryRoute,
  MessagingBrokerConfig,
  PayloadHandler,
  ResolvedTarget,
  TopicManagementOutcome,
} from './types.js';

const brokers = new WeakMap<Sandbox, MessagingBroker>();

/**
 * The broker bound to `sandbox` — created on first access, then stable.
 * `config` applies only on the creating call (subsequent callers share the
 * already-configured instance; passing a different config later is a no-op
 * by design, mirroring how per-sandbox service state behaves elsewhere).
 */
export function getMessagingBroker(sandbox: Sandbox, config?: MessagingBrokerConfig): MessagingBroker {
  const existing = brokers.get(sandbox);
  if (existing !== undefined) return existing;
  const broker = new MessagingBroker({ ...config, sandbox });
  brokers.set(sandbox, broker);
  return broker;
}
