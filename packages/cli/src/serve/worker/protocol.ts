/**
 * SharedWorker protocol — message types + wire serialization.
 *
 * Barrel module re-exporting modular domain protocol definitions:
 *   - `./protocol/firestore.js` (Firestore refs, sentinels, aggregates, doc data codec)
 *   - `./protocol/auth.js` (SerializedUser, ResolvedIdentity, AuthSubMessage, serializeUser)
 *   - `./protocol/storage.js` (Base64 codec + storage byte payload limits)
 */

export * from './protocol/firestore.js';
export * from './protocol/auth.js';
export * from './protocol/storage.js';

import type {
  TargetDescriptor,
  AggregateSpecDescriptor,
  WriteDescriptor,
  TxnReadEntry,
  FirestoreSubMessage,
} from './protocol/firestore.js';
import type {
  AuthPersistenceMode,
  ResolvedIdentity,
  AuthSubMessage,
} from './protocol/auth.js';
import type { AuthLens, SandboxEvent, DenialContext } from 'pyric/sandbox';
import type { Query as RtdbQuery } from 'pyric/database';
import type {
  BrokerMessage,
  ClientVisibilityState,
  FcmErrorEnvelope,
} from 'pyric/messaging/internal';

// ─── AI wire shapes (cdd-deltas #98 — pyric/ai under pyric dev) ────────────

/**
 * JSON-safe engine config for the worker host's AiBroker — the wire form of
 * `pyric/ai`'s `EngineConfig`.
 */
export type AiEngineConfigWire =
  | { kind: 'scripted'; script?: Array<Record<string, unknown>> }
  | {
      kind: 'openai';
      baseUrl?: string;
      model?: string;
      modelMap?: Record<string, string>;
    }
  | { kind: 'gemini'; baseUrl?: string; apiKey?: string };

/**
 * Wire form of the Gemini error envelope an `AiBrokerError` carries.
 */
export interface AiErrorEnvelopeWire {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Array<Record<string, unknown>>;
  };
}

// ─── One-shot op messages (client → worker) ───────────────────────────────

/**
 * All one-shot operation messages share the `t:'op'` discriminator and a
 * correlation `id` that the worker echoes back in the `res` reply.
 */
export type OpMessage = (
  | {
      t: 'op';
      id: string;
      method: 'getDoc';
      path: string;
      activity?: { groupKind?: 'transaction' };
    }
  | { t: 'op'; id: string; method: 'getDocs'; source: TargetDescriptor }
  | { t: 'op'; id: string; method: 'setDoc'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { t: 'op'; id: string; method: 'updateDoc'; path: string; data: unknown }
  | { t: 'op'; id: string; method: 'deleteDoc'; path: string }
  | { t: 'op'; id: string; method: 'addDoc'; collectionPath: string; data: unknown }
  | { t: 'op'; id: string; method: 'count'; source: TargetDescriptor }
  | { t: 'op'; id: string; method: 'aggregate'; source: TargetDescriptor; spec: AggregateSpecDescriptor }
  | { t: 'op'; id: string; method: 'batchCommit'; writes: WriteDescriptor[] }
  | { t: 'op'; id: string; method: 'txnCommit'; reads: TxnReadEntry[]; writes: WriteDescriptor[] }
  | { t: 'op'; id: string; method: 'setRules'; source: string }
  | { t: 'op'; id: string; method: 'setFirestoreRules'; source: string }
  | { t: 'op'; id: string; method: 'setDatabaseRules'; source: unknown }
  | { t: 'op'; id: string; method: 'getActiveRules'; service?: 'firestore' | 'database' }
  | { t: 'op'; id: string; method: 'getRulesStatus'; service?: 'firestore' | 'database' }
  | { t: 'op'; id: string; method: 'admin.getDocument'; path: string }
  | { t: 'op'; id: string; method: 'admin.listDocuments'; path: string }
  | { t: 'op'; id: string; method: 'admin.setDocument'; path: string; data: unknown }
  | { t: 'op'; id: string; method: 'admin.deleteDocument'; path: string }
  | { t: 'op'; id: string; method: 'admin.readState'; path?: string; maxDepth?: number }
  | { t: 'op'; id: string; method: 'rtdb.get'; path: string; query?: RtdbQuerySpec }
  | { t: 'op'; id: string; method: 'rtdb.set'; path: string; value: unknown }
  | { t: 'op'; id: string; method: 'rtdb.setPriority'; path: string; priority: string | number | null }
  | { t: 'op'; id: string; method: 'rtdb.setWithPriority'; path: string; value: unknown; priority: string | number | null }
  | { t: 'op'; id: string; method: 'rtdb.update'; path: string; values: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'rtdb.remove'; path: string }
  | { t: 'op'; id: string; method: 'rtdb.push'; path: string; key: string; value?: unknown }
  | { t: 'op'; id: string; method: 'rtdb.adminSnapshot' }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectSet'; path: string; value: unknown; priority?: string | number | null }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectUpdate'; path: string; values: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectRemove'; path: string }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectCancel'; path: string }
  | { t: 'op'; id: string; method: 'rtdb.goOffline' }
  | { t: 'op'; id: string; method: 'rtdb.goOnline' }
  | {
      t: 'op';
      id: string;
      method: 'rtdb.transactionCommit';
      path: string;
      expected: unknown;
      value: unknown;
      applyLocally?: boolean;
    }
  | { t: 'op'; id: string; method: 'listRootCollections' }
  | { t: 'op'; id: string; method: 'listSubcollections'; docPath: string }
  // ── Auth ops (surface: 'auth') ──────────────────────────────────────────
  // `tenantId` on the sign-in ops carries the calling port's `Auth.tenantId`
  // (absent or null means the project-level pool). Sessions are per-port, so
  // the tenant travels with each request rather than being worker state: two
  // ports can hold the same identity under different tenants.
  | { t: 'op'; id: string; method: 'auth.createUser'; email: string; password: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signInEmail'; email: string; password: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signInAnonymously'; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signOut' }
  | { t: 'op'; id: string; method: 'auth.getIdToken'; forceRefresh?: boolean }
  | { t: 'op'; id: string; method: 'auth.getIdTokenResult'; forceRefresh?: boolean }
  | { t: 'op'; id: string; method: 'auth.setPersistence'; mode: AuthPersistenceMode }
  | { t: 'op'; id: string; method: 'auth.getCurrentUser' }
  | { t: 'op'; id: string; method: 'auth.updateProfile'; displayName?: string | null; photoURL?: string | null }
  | { t: 'op'; id: string; method: 'auth.setTenantId'; tenantId: string | null }
  | { t: 'op'; id: string; method: 'auth.reload' }
  | { t: 'op'; id: string; method: 'auth.deleteUser' }
  | { t: 'op'; id: string; method: 'auth.updateEmail'; email: string }
  | { t: 'op'; id: string; method: 'auth.updatePassword'; password: string }
  | { t: 'op'; id: string; method: 'auth.updateCurrentUser'; uid: string | null }
  | {
      t: 'op';
      id: string;
      method: 'auth.signInWithCredential';
      credential: {
        providerId: string;
        idToken?: string | null;
        accessToken?: string | null;
        rawNonce?: string | null;
        email?: string | null;
        displayName?: string | null;
        photoURL?: string | null;
        uid?: string | null;
      };
    }
  | { t: 'op'; id: string; method: 'auth.restorePortSession'; uid: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.acceptIdentity'; identity: ResolvedIdentity; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.listUsers' }
  | { t: 'op'; id: string; method: 'auth.adminCreateUser'; request: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'auth.adminUpdateUser'; uid: string; request: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'auth.adminDeleteUser'; uid: string }
  | { t: 'op'; id: string; method: 'auth.adminClearUsers' }
  | { t: 'op'; id: string; method: 'auth.getProviderConfig' }
  | { t: 'op'; id: string; method: 'auth.setProviderConfig'; providerId: string; enabled: boolean }
  // Storage ops
  | { t: 'op'; id: string; method: 'storage.listAll'; path: string }
  | { t: 'op'; id: string; method: 'storage.getMetadata'; path: string }
  | { t: 'op'; id: string; method: 'storage.getBlob'; path: string }
  | { t: 'op'; id: string; method: 'storage.putBytes'; path: string; dataB64: string; contentType?: string; metadata?: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'storage.getBytes'; path: string }
  | { t: 'op'; id: string; method: 'storage.deleteObject'; path: string }
  // AI ops
  | { t: 'op'; id: string; method: 'ai.generateContent'; model: string; request: Record<string, unknown>; engine?: AiEngineConfigWire }
  | { t: 'op'; id: string; method: 'ai.countTokens'; model: string; request: Record<string, unknown>; engine?: AiEngineConfigWire }
  | { t: 'op'; id: string; method: 'getRuntimeEpoch' }
  | { t: 'op'; id: string; method: 'retireRuntime'; targetEpoch: string }
  | { t: 'op'; id: string; method: 'getVersion' }
  | { t: 'op'; id: string; method: 'exportState' }
  | { t: 'op'; id: string; method: 'importState'; bundle: string }
  | { t: 'op'; id: string; method: 'saveBranch'; name: string }
  | { t: 'op'; id: string; method: 'listBranches' }
  | { t: 'op'; id: string; method: 'switchBranch'; name: string }
  | { t: 'op'; id: string; method: 'deleteBranch'; name: string }
  | { t: 'op'; id: string; method: 'getSnapshot' }
  | { t: 'op'; id: string; method: 'resetAll' }
  // Messaging ops
  | { t: 'op'; id: string; method: 'messaging.getToken'; registrationId?: string }
  | { t: 'op'; id: string; method: 'messaging.deleteToken'; registrationId?: string }
  | { t: 'op'; id: string; method: 'messaging.send'; message: BrokerMessage; validateOnly?: boolean }
  | { t: 'op'; id: string; method: 'messaging.subscribeToTopic'; tokens: string[]; topic: string }
  | { t: 'op'; id: string; method: 'messaging.unsubscribeFromTopic'; tokens: string[]; topic: string }
  | { t: 'op'; id: string; method: 'messaging.deliver'; spec: MessagingDeliverSpec }
  | { t: 'op'; id: string; method: 'messaging.setVisibility'; state: ClientVisibilityState }
  // Connected-page presence (#227)
  | {
      t: 'op';
      id: string;
      method: 'presence.register';
      clientId: string;
      kind: PresenceClientKind;
      route: string;
      visibility: PresenceVisibility;
    }
  | { t: 'op'; id: string; method: 'presence.heartbeat'; clientId: string }
  | {
      t: 'op';
      id: string;
      method: 'presence.update';
      clientId: string;
      route?: string;
      visibility?: PresenceVisibility;
    }
  | { t: 'op'; id: string; method: 'presence.disconnect'; clientId: string }
) & {
  actAs?: AuthLens;
  issuer?: 'studio';
  relaySource?: 'remote';
};

/**
 * Wire form of the broker's `deliver` spec (`messaging.deliver`).
 */
export interface MessagingDeliverSpec {
  visibilityState?: ClientVisibilityState;
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; image?: string };
  from?: string;
  messageId?: string;
}

// ─── Subscription messages (client → worker) ─────────────────────────────

export interface EventSubMessage {
  t: 'sub';
  subId: string;
  target: 'events';
}

export interface RtdbValueSubMessage {
  t: 'sub';
  subId: string;
  target: { service: 'rtdb'; path: string; query?: RtdbQuerySpec };
  actAs?: AuthLens;
  issuer?: 'studio';
  relaySource?: 'remote';
}

/** Structured-clone-safe query plan carried by `pyric/database` Query values. */
export type RtdbQuerySpec = RtdbQuery['_spec'];

export interface AiStreamSubMessage {
  t: 'sub';
  subId: string;
  target: { service: 'ai'; op: 'streamGenerateContent' };
  model: string;
  request: Record<string, unknown>;
  engine?: AiEngineConfigWire;
}

export interface MessagingSubMessage {
  t: 'sub';
  subId: string;
  target: 'messaging.foreground' | 'messaging.background';
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
  | AuthSubMessage
  | EventSubMessage
  | RtdbValueSubMessage
  | AiStreamSubMessage
  | MessagingSubMessage
  | PresenceSubMessage;

/** Type guard: is this an event-stream subscription? */
export function isEventSub(msg: SubMessage): msg is EventSubMessage {
  return msg.target === 'events';
}

/** Type guard: is this a messaging delivery subscription? */
export function isMessagingSub(msg: SubMessage): msg is MessagingSubMessage {
  return msg.target === 'messaging.foreground' || msg.target === 'messaging.background';
}

/** Type guard: is this a connected-page presence subscription? */
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

/** Type guard: is this an AI stream subscription? */
export function isAiSub(msg: SubMessage): msg is AiStreamSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'ai'
  );
}

/** Tear down a previously registered snapshot listener. */
export interface UnsubMessage {
  t: 'unsub';
  subId: string;
}

/** Explicit app-port teardown; MessagePort close events are unreliable in Chrome. */
export interface DisconnectMessage {
  t: 'disconnect';
  id: string;
}

/** Bind an app-owned port to the worker's one Firebase configuration. */
export interface AppConfigMessage {
  t: 'appConfig';
  options: Record<string, unknown>;
}

/** Agent tool-call, forwarded by the bridge peer to the worker. */
export interface ToolMessage {
  t: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
  actAs?: AuthLens;
}

export type InboundMessage = (
  | OpMessage
  | SubMessage
  | UnsubMessage
  | DisconnectMessage
  | AppConfigMessage
  | ToolMessage
) & {
  clientSessionId?: string;
  resumeSession?: boolean;
};

// ─── Worker → client messages ─────────────────────────────────────────────

export type ResMessage =
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; error: SerializedError };

export interface SnapMessage {
  t: 'snap';
  subId: string;
  value: unknown;
}

export interface EventStreamMessage {
  t: 'event';
  subId: string;
  events: readonly SandboxEvent[];
}

export interface RuntimeReloadMessage {
  t: 'runtime-reload';
  epoch: string;
}

export type OutboundMessage = (
  | ResMessage
  | SnapMessage
  | EventStreamMessage
  | RuntimeReloadMessage
) & {
  clientSessionId?: string;
};

// ─── Error serialization ──────────────────────────────────────────────────

export interface SerializedError {
  code: string;
  message: string;
  denialContext?: DenialContext;
  aiEnvelope?: AiErrorEnvelopeWire;
  envelope?: FcmErrorEnvelope;
}

export function serializeError(err: unknown): SerializedError {
  if (err !== null && typeof err === 'object') {
    const envelope = (err as { envelope?: AiErrorEnvelopeWire }).envelope;
    if (
      envelope !== null &&
      typeof envelope === 'object' &&
      typeof envelope.error?.code === 'number' &&
      typeof envelope.error?.message === 'string' &&
      typeof envelope.error?.status === 'string'
    ) {
      return {
        code: `ai/${envelope.error.status}`,
        message: envelope.error.message,
        aiEnvelope: envelope,
      };
    }
    const e = err as { code?: unknown; message?: unknown; denialContext?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return e.denialContext !== null && typeof e.denialContext === 'object'
        ? { code: e.code, message: e.message, denialContext: e.denialContext as DenialContext }
        : { code: e.code, message: e.message };
    }
    if (err instanceof Error) {
      return { code: 'unknown', message: err.message };
    }
  }
  return { code: 'unknown', message: String(err) };
}
