import { rehydrateDocValue } from 'pyric/firestore/internal/value-codec';
import type { AuthLens, SandboxEvent, DenialContext } from 'pyric/sandbox';
import type { Query as RtdbQuery } from 'pyric/database';
import type { FcmErrorEnvelope } from 'pyric/messaging/internal';
import type {
  TargetDescriptor,
  AiEngineConfigWire,
  AiErrorEnvelopeWire,
  OpMessage,
} from './protocol.js';

export interface SerializedUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly tenantId: string | null;
  readonly providerId: string | null;
  readonly providerData: ReadonlyArray<{
    readonly displayName: string | null;
    readonly email: string | null;
    readonly phoneNumber: string | null;
    readonly photoURL: string | null;
    readonly providerId: string;
    readonly uid: string;
  }>;
}

export interface ResolvedIdentity {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly customClaims: Record<string, unknown>;
  readonly providerId: string;
}

export interface SerializedUserCredential {
  readonly user: SerializedUser;
  readonly providerId: string | null;
  readonly operationType: 'signIn' | 'reauthenticate' | 'link';
}

export interface SerializedIdTokenResult {
  readonly token: string;
  readonly claims: Record<string, unknown>;
  readonly expirationTime: string;
  readonly issuedAtTime: string;
  readonly authTime: string;
  readonly signInProvider: string | null;
}

export function serializeUser(
  user: {
    uid: string;
    email: string | null;
    emailVerified?: boolean;
    displayName: string | null;
    photoURL?: string | null;
    phoneNumber?: string | null;
    isAnonymous: boolean;
    tenantId?: string | null;
    providerId?: string;
    providerData?: ReadonlyArray<{
      displayName: string | null;
      email: string | null;
      phoneNumber: string | null;
      photoURL: string | null;
      providerId: string;
      uid: string;
    }>;
  } | null,
): SerializedUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified ?? false,
    displayName: user.displayName,
    photoURL: user.photoURL ?? null,
    phoneNumber: user.phoneNumber ?? null,
    isAnonymous: user.isAnonymous,
    tenantId: user.tenantId ?? null,
    providerId: user.providerId ?? null,
    providerData: (user.providerData ?? []).map((p) => ({
      displayName: p.displayName,
      email: p.email,
      phoneNumber: p.phoneNumber,
      photoURL: p.photoURL,
      providerId: p.providerId,
      uid: p.uid,
    })),
  };
}

export type AuthPersistenceMode = 'LOCAL' | 'SESSION' | 'NONE';

// ─── Subscription messages (client → worker) ─────────────────────────────

/** Register a Firestore snapshot listener for a doc or query. The worker
 *  fires `{ t:'snap', subId, value }` immediately (initial) and on each
 *  update. */
export interface FirestoreSubMessage {
  t: 'sub';
  subId: string;
  target: TargetDescriptor;
  actAs?: AuthLens;
  issuer?: 'studio';
  relaySource?: 'remote';
}

/**
 * Register an AUTH listener (cross-tab auth — the headline of Phase 2).
 */
export interface AuthSubMessage {
  t: 'sub';
  subId: string;
  target: 'authState' | 'idToken';
}

/**
 * Subscribe to the sandbox's unified cross-service EVENT STREAM.
 */
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

/**
 * Stream a `generateContent` call as a SUBSCRIPTION.
 */
export interface AiStreamSubMessage {
  t: 'sub';
  subId: string;
  target: { service: 'ai'; op: 'streamGenerateContent' };
  model: string;
  request: Record<string, unknown>;
  engine?: AiEngineConfigWire;
}

/**
 * Register a MESSAGING delivery listener.
 */
export interface MessagingSubMessage {
  t: 'sub';
  subId: string;
  target: 'messaging.foreground' | 'messaging.background';
}

/**
 * Subscribe to connected-page presence (#227).
 */
export interface PresenceSubMessage {
  t: 'sub';
  subId: string;
  target: 'presence';
}

/** Logical page kind for presence (#227). */
export type PresenceClientKind = 'app' | 'studio';

/** Page Visibility API state carried on presence records. */
export type PresenceVisibility = 'visible' | 'hidden';

/** One logical connected page in a presence snapshot. */
export interface PresenceClientRecord {
  clientId: string;
  kind: PresenceClientKind;
  route: string;
  visibility: PresenceVisibility;
  connectedAt: number;
  lastSeen: number;
}

/** Authoritative presence snapshot owned by the SharedWorker host. */
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

/** Type guard: is this an auth subscription (vs a Firestore / event one)? */
export function isAuthSub(msg: SubMessage): msg is AuthSubMessage {
  return msg.target === 'authState' || msg.target === 'idToken';
}

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

/** Type guard: is this an AI stream subscription (finite, auto-unsubs on done)? */
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

/**
 * Bind an app-owned port to the worker's one Firebase configuration.
 */
export interface AppConfigMessage {
  t: 'appConfig';
  options: Record<string, unknown>;
}

/**
 * Agent tool-call, forwarded by the bridge peer to the worker.
 */
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

// ─── Serialized document data ─────────────────────────────────────────────

export interface SerializedDocData {
  json: string;
}

export function serializeDocData(data: Record<string, unknown>): SerializedDocData {
  return { json: JSON.stringify(data) };
}

export function deserializeDocData(serialized: SerializedDocData): unknown {
  return rehydrateDocValue(JSON.parse(serialized.json));
}

// ─── Storage byte payloads (base64 + size cap) ────────────────────────────

export const MAX_STORAGE_OP_BYTES = 8 * 1024 * 1024;

export const MAX_STORAGE_OP_B64_LENGTH = Math.ceil(MAX_STORAGE_OP_BYTES / 3) * 4;

export function storagePayloadTooLarge(
  sizeBytes: number,
  what: string,
): Error & { code: string } {
  const err = new Error(
    `${what} is ${sizeBytes} bytes — over the ${MAX_STORAGE_OP_BYTES / (1024 * 1024)} MiB ` +
      'storage op cap (MAX_STORAGE_OP_BYTES). Streaming/resumable transfers are not ' +
      'supported on the sandbox backend; split the object or keep it under the cap.',
  ) as Error & { code: string };
  err.code = 'payload-too-large';
  return err;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

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
