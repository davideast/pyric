import type { Query as RtdbQuery } from 'pyric/database';
import type { AuthLens, ListenerOwner } from 'pyric/sandbox';
import type { AiAppCheckWire, AiEngineConfigWire } from './ai.js';
import type { AuthSubMessage } from './auth.js';
import type { FirestoreSubMessage, ResponseDocValueEncoding } from './firestore.js';

export interface FirestoreWriteSubMessage {
  t: 'sub';
  subId: string;
  target: {
    service: 'firestore.writes';
    database?: string;
  };
  actAs?: AuthLens;
  docValueEncoding?: ResponseDocValueEncoding;
  issuer?: 'studio';
  relaySource?: 'remote';
}

export interface EventSubMessage {
  t: 'sub';
  subId: string;
  target: 'events';
  /** The subscribing page's tab id (`AppConfigMessage.tabId`); the history batch answers with `pageId`. */
  tabId?: string;
  /** The subscribing page's browser profile id (`AppConfigMessage.clientId`), for a port that sends no `appConfig`. */
  clientId?: string;
}

/** Structured-clone-safe query plan carried by `pyric/database` Query values. */
export type RtdbQuerySpec = RtdbQuery['_spec'];

/** JSON-safe wire form of {@link RtdbQuerySpec} (`limit.n === null` encodes `+Infinity` across JSON transports). */
export type RtdbWireQuerySpec = Omit<RtdbQuerySpec, 'limit'> & {
  limit: { kind: 'limitToFirst' | 'limitToLast'; n: number | null } | null;
};

export interface RtdbValueSubMessage {
  t: 'sub';
  subId: string;
  target: {
    service: 'rtdb';
    instance: string | undefined;
    path: string;
    query?: RtdbWireQuerySpec;
    event?: 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';
  };
  actAs?: AuthLens;
  /** The listener's owners, derived on the page. */
  owners?: ListenerOwner[];
  issuer?: 'studio';
  relaySource?: 'remote';
}

export interface StorageSubMessage {
  t: 'sub';
  subId: string;
  target: {
    service: 'storage';
    bucket?: string;
    defaultBucket?: string;
  };
  actAs?: AuthLens;
  relaySource?: 'remote';
}

export interface AiStreamSubMessage {
  t: 'sub';
  subId: string;
  target: { service: 'ai'; op: 'streamGenerateContent' };
  model: string;
  request: Record<string, unknown>;
  engine?: AiEngineConfigWire;
  appCheck?: AiAppCheckWire;
}

type MessagingSubTarget =
  | 'messaging.foreground'
  | 'messaging.background'
  | 'messaging.registered'
  | 'messaging.unregistered';

export interface MessagingSubMessage {
  t: 'sub';
  subId: string;
  target: MessagingSubTarget;
  recipientId?: string;
}

export interface PresenceSubMessage {
  t: 'sub';
  subId: string;
  target: 'presence';
}

export type PresenceClientKind = 'app' | 'studio';
export type PresenceVisibility = 'visible' | 'hidden';

export interface PresenceClientRecord {
  clientId: string;
  kind: PresenceClientKind;
  route: string;
  visibility: PresenceVisibility;
  connectedAt: number;
  lastSeen: number;
}

export interface PresenceSnapshot {
  clients: PresenceClientRecord[];
}

export type SubMessage =
  | FirestoreSubMessage
  | FirestoreWriteSubMessage
  | AuthSubMessage
  | EventSubMessage
  | RtdbValueSubMessage
  | StorageSubMessage
  | AiStreamSubMessage
  | MessagingSubMessage
  | PresenceSubMessage;

export function isFirestoreWriteSub(msg: SubMessage): msg is FirestoreWriteSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'firestore.writes'
  );
}

export function isEventSub(msg: SubMessage): msg is EventSubMessage {
  return msg.target === 'events';
}

function isMessagingSubTarget(target: unknown): target is MessagingSubTarget {
  return (
    target === 'messaging.foreground' ||
    target === 'messaging.background' ||
    target === 'messaging.registered' ||
    target === 'messaging.unregistered'
  );
}

export function isMessagingSub(msg: SubMessage): msg is MessagingSubMessage {
  return isMessagingSubTarget(msg.target);
}

export function isPresenceSub(msg: SubMessage): msg is PresenceSubMessage {
  return msg.target === 'presence';
}

export function isRtdbSub(msg: SubMessage): msg is RtdbValueSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'rtdb'
  );
}

export function isStorageSub(msg: SubMessage): msg is StorageSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'storage'
  );
}

export function isAiSub(msg: SubMessage): msg is AiStreamSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'ai'
  );
}
