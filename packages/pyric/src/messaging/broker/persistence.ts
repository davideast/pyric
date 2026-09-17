import { TOKEN_SHAPE_RE, isValidTopicName } from './validate.js';

export interface TokenRecord {
  registrationId: string;
  recipientId: string;
  state: 'active' | 'unregistered';
}

export interface MessagingSnapshot {
  version: 1;
  tokens: Array<[string, TokenRecord]>;
  topics: Array<[string, string[]]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  const isObjectRecord = typeof value === 'object' && value !== null && !Array.isArray(value);
  return isObjectRecord;
}

function isTokenEntry(value: unknown): value is [string, TokenRecord] {
  const isPair = Array.isArray(value) && value.length === 2;
  if (!isPair) return false;
  const [token, record] = value;
  const hasToken = typeof token === 'string' && TOKEN_SHAPE_RE.test(token);
  const hasRecord = isRecord(record);
  const isValidEntry = hasToken && hasRecord;
  if (!isValidEntry) return false;
  const hasRegistration = typeof record.registrationId === 'string' && record.registrationId.length > 0;
  const hasRecipient = typeof record.recipientId === 'string' && record.recipientId.length > 0;
  const hasState = record.state === 'active' || record.state === 'unregistered';
  return hasRegistration && hasRecipient && hasState;
}

function isToken(value: unknown): value is string {
  const hasTokenShape = typeof value === 'string' && TOKEN_SHAPE_RE.test(value);
  return hasTokenShape;
}

function isTopicEntry(value: unknown): value is [string, string[]] {
  const isPair = Array.isArray(value) && value.length === 2;
  if (!isPair) return false;
  const [topic, tokens] = value;
  const hasTopic = typeof topic === 'string' && isValidTopicName(topic);
  const hasTokens = Array.isArray(tokens) && tokens.every(isToken);
  return hasTopic && hasTokens;
}

export function isMessagingSnapshot(value: unknown): value is MessagingSnapshot {
  if (!isRecord(value)) return false;
  const hasVersion = value.version === 1;
  const hasTokens = Array.isArray(value.tokens) && value.tokens.every(isTokenEntry);
  const hasTopics = Array.isArray(value.topics) && value.topics.every(isTopicEntry);
  return hasVersion && hasTokens && hasTopics;
}
