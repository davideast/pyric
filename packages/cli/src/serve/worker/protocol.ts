import type { DeliveryStage } from 'pyric/messaging/internal';
import type { ActionCodeSettings } from 'pyric/auth';
/**
 * SharedWorker protocol -- message types + wire serialization.
 *
 * Barrel module re-exporting modular domain protocol definitions:
 *   - `./protocol/firestore.js` (Firestore refs, sentinels, aggregates, doc data codec)
 *   - `./protocol/auth.js` (SerializedUser, ResolvedIdentity, AuthSubMessage, serializeUser)
 *   - `./protocol/storage.js` (Base64 codec + storage byte payload limits)
 *   - `./protocol/app-check.js` (App Check token minting ops)
 *   - `./protocol/error-serialization.js` (SerializedError + wire error shaping)
 */

export * from './protocol/firestore.js';
export * from './protocol/auth.js';
export * from './protocol/storage.js';
export * from './protocol/app-check.js';
export * from './protocol/crashlytics.js';
export * from './protocol/ai.js';
export * from './protocol/subscriptions.js';
export * from './protocol/error-serialization.js';

import type {
  TargetDescriptor,
  DocValueEncoding,
  ResponseDocValueEncoding,
  AggregateSpecDescriptor,
  WriteDescriptor,
  UpdatePayload,
  TxnReadEntry,
  TxnQueryReadEntry,
} from './protocol/firestore.js';
import type {
  AuthBlockingRespondOpMessage,
  AuthPersistenceMode,
  SerializedAuthCredential,
  ResolvedIdentity,
} from './protocol/auth.js';
import type { AppCheckOpMessage } from './protocol/app-check.js';
import type { CrashlyticsOpMessage } from './protocol/crashlytics.js';
import type { AiAppCheckWire, AiEngineConfigWire } from './protocol/ai.js';
import type {
  PresenceClientKind,
  PresenceVisibility,
  RtdbWireQuerySpec,
  SubMessage,
} from './protocol/subscriptions.js';
import type { SerializedError } from './protocol/error-serialization.js';
import type {
  AuthLens,
  SandboxClockState,
  SandboxEvent,
  ObservedCall,
} from 'pyric/sandbox';
import type { NodeUnobservedLists } from 'pyric/sandbox/internal';
import type { ObservedSessionDelta } from '../observed-session/wire.js';
import type {
  BrokerMessage,
  ClientVisibilityState,
} from 'pyric/messaging/internal';

// ─── One-shot op messages (client → worker) ───────────────────────────────

/**
 * All one-shot operation messages share the `t:'op'` discriminator and a
 * correlation `id` that the worker echoes back in the `res` reply.
 */
/**
 * The bucket a Storage object op names. Without `bucket`, the op is on the
 * host's default bucket. `defaultBucket` is the caller's name for that default
 * bucket, as its app's `storageBucket` option names it: the op then reaches the
 * default bucket under that name too, and so do byte route URLs that carry it.
 */
export interface StorageBucketWire {
  bucket?: string;
  defaultBucket?: string;
}

/** A metadata change from the admin plane, as `pyric/storage/internal`'s `patchObjectMetadata` takes it. */
interface StorageMetadataPatchWire {
  settable?: {
    contentType?: string | null;
    cacheControl?: string | null;
    contentDisposition?: string | null;
    contentEncoding?: string | null;
    contentLanguage?: string | null;
  };
  customMetadata?: Record<string, string | null>;
  downloadTokens?: string | null;
}

/** Worker protocol version: 2 adds optional Firestore `databaseId` on ops and subscriptions (ADR-0021 Decision 4). */
export const WORKER_PROTOCOL_VERSION = 2 as const;

export type OpMessage = (
  | {
      t: 'op';
      id: string;
      method: 'getDoc';
      path: string;
      txnId?: string;
      databaseId?: string;
      activity?: { groupKind?: 'transaction' };
    }
  | { t: 'op'; id: string; method: 'getDocs'; source: TargetDescriptor; txnId?: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'setDoc'; path: string; data: unknown; valueEncoding?: DocValueEncoding; options?: { merge?: boolean; mergeFields?: string[] }; databaseId?: string }
  | ({ t: 'op'; id: string; method: 'updateDoc'; path: string; valueEncoding?: DocValueEncoding; databaseId?: string } & UpdatePayload)
  | { t: 'op'; id: string; method: 'deleteDoc'; path: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'addDoc'; collectionPath: string; data: unknown; valueEncoding?: DocValueEncoding; databaseId?: string }
  | { t: 'op'; id: string; method: 'count'; source: TargetDescriptor; databaseId?: string }
  | { t: 'op'; id: string; method: 'aggregate'; source: TargetDescriptor; spec: AggregateSpecDescriptor; databaseId?: string }
  | { t: 'op'; id: string; method: 'batchCommit'; writes: WriteDescriptor[]; databaseId?: string }
  | { t: 'op'; id: string; method: 'txnCommit'; txnId?: string; abortOnly?: boolean; reads: TxnReadEntry[]; queryReads?: TxnQueryReadEntry[]; writes: WriteDescriptor[]; databaseId?: string }
  | { t: 'op'; id: string; method: 'setRules'; source: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'setFirestoreRules'; source: string; databaseId?: string }
  // `instance` names an RTDB instance (the SDK's namespace) on the RTDB ops,
  // RTDB subscriptions and the database rules ops. Absent is the default
  // instance.
  | { t: 'op'; id: string; method: 'setDatabaseRules'; source: unknown; instance?: string }
  | { t: 'op'; id: string; method: 'getActiveRules'; service?: 'firestore' | 'database'; instance?: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'getRulesStatus'; service?: 'firestore' | 'database'; instance?: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'admin.getDocument'; path: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'admin.listDocuments'; path: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'admin.setDocument'; path: string; data: unknown; databaseId?: string }
  | { t: 'op'; id: string; method: 'admin.deleteDocument'; path: string; databaseId?: string }
  | { t: 'op'; id: string; method: 'admin.readState'; path?: string; maxDepth?: number; databaseId?: string }
  | {
      t: 'op'; id: string; method: 'rtdb.get'; instance: string | undefined; path: string; query?: RtdbWireQuerySpec;
      /** A transaction's read of its current value: the sandbox's transaction
       *  engine reads it without evaluating read rules, so this read does not
       *  either. The commit evaluates the write rules. */
      transaction?: true;
    }
  | { t: 'op'; id: string; method: 'rtdb.set'; instance: string | undefined; path: string; value: unknown }
  | { t: 'op'; id: string; method: 'rtdb.setPriority'; instance: string | undefined; path: string; priority: string | number | null }
  | { t: 'op'; id: string; method: 'rtdb.setWithPriority'; instance: string | undefined; path: string; value: unknown; priority: string | number | null }
  | { t: 'op'; id: string; method: 'rtdb.update'; instance: string | undefined; path: string; values: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'rtdb.remove'; instance: string | undefined; path: string }
  // `key` is the client's when the client needed it synchronously (the page's
  // `push()` returns a reference before the write lands). A caller that can
  // wait omits it, and the host mints one from the sandbox clock.
  | { t: 'op'; id: string; method: 'rtdb.push'; instance: string | undefined; path: string; key?: string; value?: unknown }
  // Read the sandbox clock. For a caller in another process, which cannot
  // mirror the stream a page port gets and can afford the round trip.
  | { t: 'op'; id: string; method: 'sandbox.clock' }
  | { t: 'op'; id: string; method: 'rtdb.adminSnapshot'; instance: string | undefined }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectSet'; instance: string | undefined; connectionId?: string; path: string; value: unknown; priority?: string | number | null }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectUpdate'; instance: string | undefined; connectionId?: string; path: string; values: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectRemove'; instance: string | undefined; connectionId?: string; path: string }
  | { t: 'op'; id: string; method: 'rtdb.onDisconnectCancel'; instance: string | undefined; connectionId?: string; path: string }
  | { t: 'op'; id: string; method: 'rtdb.goOffline'; instance: string | undefined; connectionId?: string; sever?: boolean }
  | { t: 'op'; id: string; method: 'rtdb.goOnline'; instance: string | undefined; connectionId?: string }
  | {
      t: 'op';
      id: string;
      method: 'rtdb.transactionCommit';
      instance: string | undefined;
      path: string;
      expected: unknown;
      value: unknown;
      applyLocally?: boolean;
    }
  | { t: 'op'; id: string; method: 'listRootCollections'; databaseId?: string }
  | { t: 'op'; id: string; method: 'listSubcollections'; docPath: string; databaseId?: string }
  // ── Auth ops (surface: 'auth') ──────────────────────────────────────────
  // `tenantId` on the sign-in ops carries the calling port's `Auth.tenantId`
  // (absent or null means the project-level pool). Sessions are per-port, so
  // the tenant travels with each request rather than being worker state: two
  // ports can hold the same identity under different tenants.
  | { t: 'op'; id: string; method: 'auth.createUser'; email: string; password: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signInEmail'; email: string; password: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signInAnonymously'; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signOut' }
  | { t: 'op'; id: string; method: 'auth.getIdToken'; forceRefresh?: boolean; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.getIdTokenResult'; forceRefresh?: boolean; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.setPersistence'; mode: AuthPersistenceMode }
  | { t: 'op'; id: string; method: 'auth.getCurrentUser' }
  | { t: 'op'; id: string; method: 'auth.updateProfile'; displayName?: string | null; photoURL?: string | null; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.setTenantId'; tenantId: string | null }
  | { t: 'op'; id: string; method: 'auth.reload'; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.deleteUser'; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.updateEmail'; email?: string; newEmail?: string; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.updatePassword'; password?: string; newPassword?: string; uid?: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.updateCurrentUser'; uid: string | null; tenantId?: string | null; sessionKey?: string }
  | {
      t: 'op';
      id: string;
      method: 'auth.signInWithCredential';
      /**
       * An email credential carries its secret (`toJSON()`), which the host
       * verifies with the engine. A federated credential signs in as the
       * result staged for its provider, so the host reads only its
       * `providerId` and `signInMethod`.
       */
      credential?: SerializedAuthCredential | {
        providerId: string;
        signInMethod?: string;
        email?: string | null;
        displayName?: string | null;
        photoURL?: string | null;
        uid?: string | null;
        idToken?: string | null;
        accessToken?: string | null;
        refreshToken?: string | null;
        secret?: string | null;
      };
      providerId?: string;
      signInMethod?: string;
      password?: string;
      email?: string | null;
      displayName?: string | null;
      photoURL?: string | null;
      uid?: string | null;
      idToken?: string | null;
      accessToken?: string | null;
      refreshToken?: string | null;
      secret?: string | null;
      tenantId?: string | null;
    }
  | { t: 'op'; id: string; method: 'auth.linkWithCredential'; uid: string; tenantId: string | null;
      credential: SerializedAuthCredential }
  | { t: 'op'; id: string; method: 'auth.unlink'; uid: string; tenantId: string | null; providerId: string }
  | { t: 'op'; id: string; method: 'auth.reauthenticateWithCredential'; uid: string; tenantId: string | null;
      credential: SerializedAuthCredential; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.reauthenticateWithProvider'; uid: string; tenantId: string | null;
      identity: { uid: string; providerId: string }; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.sendPasswordResetEmail'; email: string; settings?: ActionCodeSettings; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.takeMail'; email?: string }
  | { t: 'op'; id: string; method: 'auth.sendSignInLinkToEmail'; email: string; settings: ActionCodeSettings; tenantId?: string | null }
  | {
      t: 'op';
      id: string;
      method: 'auth.sendSmsVerification';
      phoneNumber: string;
      smsType?: 'SIGN_IN_OR_SIGN_UP' | 'MULTI_FACTOR_SIGN_IN' | 'MULTI_FACTOR_ENROLLMENT';
      uid?: string;
      tenantId?: string | null;
    }
  | { t: 'op'; id: string; method: 'auth.takeSms'; phoneNumber?: string }
  | { t: 'op'; id: string; method: 'auth.signInWithEmailLink'; email: string; link: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.signInWithCustomToken'; customToken: string; tenantId?: string | null }
  | { t: 'op'; id: string; method: 'auth.sendEmailVerification'; uid: string; tenantId: string | null; settings?: ActionCodeSettings; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.verifyBeforeUpdateEmail'; uid: string; tenantId: string | null; newEmail: string; settings?: ActionCodeSettings; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.applyActionCode'; code: string }
  | { t: 'op'; id: string; method: 'auth.checkActionCode'; code: string }
  | { t: 'op'; id: string; method: 'auth.verifyPasswordResetCode'; code: string }
  | { t: 'op'; id: string; method: 'auth.confirmPasswordReset'; code: string; newPassword: string }
  | { t: 'op'; id: string; method: 'auth.restorePortSession'; uid: string; tenantId?: string | null; sessionKey?: string }
  | { t: 'op'; id: string; method: 'auth.acceptIdentity'; identity: ResolvedIdentity; tenantId?: string | null }
  // Stage the identity the port's next federated `signInWithCredential` for
  // `identity.providerId` signs in as (served `sandbox.mockSignInResult`).
  | { t: 'op'; id: string; method: 'auth.mockSignInResult'; identity: ResolvedIdentity }
  | { t: 'op'; id: string; method: 'auth.listUsers' }
  | { t: 'op'; id: string; method: 'auth.adminCreateUser'; request: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'auth.adminUpdateUser'; uid: string; request: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'auth.adminDeleteUser'; uid: string }
  | { t: 'op'; id: string; method: 'auth.adminGetAccountStanding'; uid: string }
  | { t: 'op'; id: string; method: 'auth.adminRevokeRefreshTokens'; uid: string }
  | { t: 'op'; id: string; method: 'auth.adminClearUsers' }
  | { t: 'op'; id: string; method: 'auth.getProviderConfig' }
  | { t: 'op'; id: string; method: 'auth.setProviderConfig'; providerId: string; enabled: boolean }
  | { t: 'op'; id: string; method: 'auth.getEmailEnumerationProtection' }
  | { t: 'op'; id: string; method: 'auth.setEmailEnumerationProtection'; enabled: boolean }
  | AuthBlockingRespondOpMessage
  // Storage ops. An object op names its bucket with `bucket`, or the host's
  // default bucket without one (see StorageBucketWire).
  | ({ t: 'op'; id: string; method: 'storage.list'; path: string; maxResults?: number | null; pageToken?: string | null } & StorageBucketWire)
  | ({ t: 'op'; id: string; method: 'storage.listAll'; path: string } & StorageBucketWire)
  | ({ t: 'op'; id: string; method: 'storage.getMetadata'; path: string } & StorageBucketWire)
  /** The object's download path on the byte route, carrying its persistent download token. */
  | ({ t: 'op'; id: string; method: 'storage.getDownloadURL'; path: string } & StorageBucketWire)
  | ({ t: 'op'; id: string; method: 'storage.getBlob'; path: string } & StorageBucketWire)
  /** firebase-admin's `File.setMetadata`, on the admin lens only: custom keys merge, `null` removes one. */
  | ({ t: 'op'; id: string; method: 'storage.setMetadata'; path: string; patch: StorageMetadataPatchWire } & StorageBucketWire)
  /**
   * An upload. `downloadTokens`, as firebase-admin's `save` sets them, is taken on the admin lens only.
   * With `rollback`, the reply's metadata carries a `rollbackToken` for `storage.rollbackUpload`,
   * and `replacedObject: true` when the commit replaced an object;
   * a host that predates it ignores the field and sends neither.
   */
  | ({ t: 'op'; id: string; method: 'storage.putBytes'; path: string; dataB64: string; contentType?: string; metadata?: Record<string, unknown>; downloadTokens?: string; rollback?: boolean } & StorageBucketWire)
  | ({ t: 'op'; id: string; method: 'storage.getBytes'; path: string; offset?: number; length?: number; expectedGeneration?: string } & StorageBucketWire)
  | ({ t: 'op'; id: string; method: 'storage.beginUpload'; path: string; size: number; contentType?: string; metadata?: Record<string, unknown>; downloadTokens?: string } & StorageBucketWire)
  | { t: 'op'; id: string; method: 'storage.putPart'; uploadId: string; partIndex: number; dataB64: string }
  /** Commit a staged upload. `rollback` asks for a `rollbackToken`, as on `storage.putBytes`. */
  | { t: 'op'; id: string; method: 'storage.finishUpload'; uploadId: string; rollback?: boolean }
  | { t: 'op'; id: string; method: 'storage.abortUpload'; uploadId: string }
  | ({ t: 'op'; id: string; method: 'storage.deleteObject'; path: string } & StorageBucketWire)
  /**
   * Roll back a canceled upload's own commit without evaluating rules: puts
   * back the object that commit replaced, or deletes the one it created, and
   * does nothing if a later write replaced the commit's generation. Replies
   * `{ deleted, restored }`; a host before #1159 replies `{ deleted }` and
   * always deletes. Refused (`storage/unauthorized`) for a token this client
   * was not issued, an expired one, or one used already. Any other failure
   * is the rollback's own, and the commit's object may still be there.
   */
  | { t: 'op'; id: string; method: 'storage.rollbackUpload'; rollbackToken: string }
  /**
   * firebase-admin's `File.copy`, on the admin lens only. The copy keeps the
   * source's metadata; `patch` changes it on the copy. `destinationBucket`
   * names the copy's bucket as `bucket` names the source's.
   */
  | ({ t: 'op'; id: string; method: 'storage.copyObject'; path: string; destinationBucket?: string; destinationDefaultBucket?: string; destinationPath: string; patch?: StorageMetadataPatchWire } & StorageBucketWire)
  /**
   * firebase-admin's `File.createResumableUpload`, on the admin lens only, on a
   * host with an HTTP byte route. Answers `{ uploadUrl }`, a byte route path
   * that takes the object's bytes in one `PUT`, or in `Content-Range` slices
   * whose first one names the total size. The object is created with this
   * metadata when its last byte arrives. `origin` is the page origin the URL
   * answers cross-origin requests from.
   */
  | ({ t: 'op'; id: string; method: 'storage.createUploadSession'; path: string; contentType?: string; metadata?: Record<string, unknown>; downloadTokens?: string; origin?: string } & StorageBucketWire)
  // AI ops
  | { t: 'op'; id: string; method: 'ai.generateContent'; model: string; request: Record<string, unknown>; engine?: AiEngineConfigWire; appCheck?: AiAppCheckWire }
  | { t: 'op'; id: string; method: 'ai.countTokens'; model: string; request: Record<string, unknown>; engine?: AiEngineConfigWire; appCheck?: AiAppCheckWire }
  | { t: 'op'; id: string; method: 'getRuntimeEpoch' }
  | { t: 'op'; id: string; method: 'retireRuntime'; targetEpoch: string }
  | { t: 'op'; id: string; method: 'getVersion' }
  | { t: 'op'; id: string; method: 'exportState' }
  | { t: 'op'; id: string; method: 'importState'; bundle: string }
  | { t: 'op'; id: string; method: 'checkpoint'; name: string }
  | { t: 'op'; id: string; method: 'listCheckpoints' }
  | { t: 'op'; id: string; method: 'restore'; name: string }
  | { t: 'op'; id: string; method: 'deleteCheckpoint'; name: string }
  | { t: 'op'; id: string; method: 'getSnapshot' }
  | { t: 'op'; id: string; method: 'resetAll' }
  // Messaging ops
  | { t: 'op'; id: string; method: 'messaging.getToken'; registrationId?: string; recipientId?: string }
  | { t: 'op'; id: string; method: 'messaging.deleteToken'; registrationId?: string; recipientId?: string }
  | { t: 'op'; id: string; method: 'messaging.register'; registrationId?: string; recipientId?: string }
  | { t: 'op'; id: string; method: 'messaging.unregister'; registrationId?: string; recipientId?: string }
  | { t: 'op'; id: string; method: 'messaging.send'; message: BrokerMessage; validateOnly?: boolean }
  | { t: 'op'; id: string; method: 'messaging.subscribeToTopic'; tokens: string[]; topic: string }
  | { t: 'op'; id: string; method: 'messaging.unsubscribeFromTopic'; tokens: string[]; topic: string }
  | { t: 'op'; id: string; method: 'messaging.deliver'; recipientId?: string; spec: MessagingDeliverSpec }
  | { t: 'op'; id: string; method: 'messaging.acknowledge'; subId: string; messageId: string; stage: DeliveryStage }
  | { t: 'op'; id: string; method: 'messaging.setVisibility'; recipientId?: string; state: ClientVisibilityState }
  | AppCheckOpMessage
  // Connected-page presence (#227)
  | {
      t: 'op';
      id: string;
      method: 'presence.register';
      clientId: string;
      kind: PresenceClientKind;
      route: string;
      visibility: PresenceVisibility;
      /** A live page's signed-in user's email, null when signed out. A live host keeps it in memory and strips it before the Node sandbox. */
      email?: string | null;
    }
  | { t: 'op'; id: string; method: 'presence.heartbeat'; clientId: string }
  | {
      t: 'op';
      id: string;
      method: 'presence.update';
      clientId: string;
      route?: string;
      visibility?: PresenceVisibility;
      /** Sent when a live page's user changes; see `presence.register`. */
      email?: string | null;
    }
  | { t: 'op'; id: string; method: 'presence.disconnect'; clientId: string }
  | CrashlyticsOpMessage
) & {
  actAs?: AuthLens;
  issuer?: 'studio'; relaySource?: 'remote'; docValueEncoding?: ResponseDocValueEncoding;
};

/**
 * Wire form of the broker's `deliver` spec (`messaging.deliver`).
 */
interface MessagingDeliverSpec {
  visibilityState?: ClientVisibilityState;
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; image?: string };
  from?: string;
  messageId?: string;
}

// --- Subscription teardown & control messages (client -> worker) ---

/** Tear down a previously registered snapshot listener. */
export interface UnsubMessage {
  t: 'unsub';
  subId: string;
}

/** Explicit app-port teardown; MessagePort close events are unreliable in Chrome. */
interface DisconnectMessage {
  t: 'disconnect';
  id: string;
}

/** Bind an app-owned port to the worker's one Firebase configuration. */
export interface AppConfigMessage {
  t: 'appConfig';
  options: Record<string, unknown>;
  /** Set when a long-lived client re-attaches from an earlier host instance without reloading. */
  fromPriorHost?: boolean;
  /** Set when the attaching client proved compile-time/HTML origin from this running host instance. */
  hostVerified?: boolean;
  /** The page's `location.origin`; the host resolves relative photo URLs against it. */
  origin?: string;
  /**
   * The page's tab id, kept in `sessionStorage` so it survives a reload. Every
   * port the tab opens sends the same one, and the host stamps it on the
   * tab's events as `caller.pageId`. A label, never an authority.
   */
  tabId?: string;
  /**
   * The browser profile's client id, kept in `localStorage`, so every tab of
   * one profile sends the same one; a service worker sends its realm's. The
   * host stamps it on the port's events as `caller.clientId`. A label, never
   * an authority.
   */
  clientId?: string;
}

/**
 * Ask the host to stream this port the sandbox clock's state.
 *
 * The clock lives in the worker, and a page reads it synchronously: a push id
 * and an in-flight upload stamp are minted before any round trip can complete.
 * So the state is mirrored rather than fetched. The host answers with the
 * current {@link ClockMessage} and sends another on every later move.
 */
interface ClockSubscribeMessage {
  t: 'clock-subscribe';
}

/** Agent tool-call, forwarded by the bridge peer to the worker. */
export interface ToolMessage {
  t: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
  actAs?: AuthLens;
}

/**
 * A call the app made to production, as a recorder beside the app observed it
 * (`ObservedCall` in `pyric/sandbox`). The host checks the record, writes it
 * to the event stream with the caller it stamps from this connection, and
 * answers `res`. A malformed record is refused with `invalid-argument`.
 * Nothing in pyric sends this frame.
 */
export interface ObserveMessage {
  t: 'observe';
  id: string;
  call: ObservedCall;
  /**
   * A live Node process's label for its project root and entry script, a
   * hash that carries no path. When a connection with a label sends its
   * first frame, the host detaches the listeners an earlier connection with
   * the same label reported if that one has closed: a restarted process. A
   * label, never an authority.
   */
  nodeClient?: string;
  /**
   * The script the sender runs, which the live host lists as its client's
   * label: a Node process's entry script relative to its working directory
   * (`server.mjs`), or a service worker's script URL path (`/sw.js`). Never
   * an absolute file path, an origin or a query. A label, never an
   * authority; the host drops a malformed one and keeps the client.
   */
  script?: string;
  /**
   * Optional bounded Firestore/RTDB document and snapshot values observed by
   * a `@pyric/live` client in this session. Retained strictly in live-host
   * memory (`observed-session/store.ts`) and stripped before repro recording.
   */
  sessionData?: ObservedSessionDelta;
}

/**
 * What a Node process under the live register left unobserved: the
 * firebase-admin subpaths it loaded that no row serves or whose row records no
 * call (`NodeUnobservedLists` in `pyric/sandbox/internal`). Names only, each
 * list bounded and absent when empty. The process sends the whole lists when
 * one first gains an entry and again on each change; the live host lists them
 * under the process's client (`live-clients.ts`) and the sandbox answers
 * `res`. A frame whose lists are malformed is refused with `invalid-argument`.
 */
interface UnobservedMessage extends NodeUnobservedLists {
  t: 'unobserved';
  id: string;
}

export type InboundMessage = (
  | OpMessage
  | SubMessage
  | UnsubMessage
  | DisconnectMessage
  | AppConfigMessage
  | ClockSubscribeMessage
  | ToolMessage
  | ObserveMessage
  | UnobservedMessage
) & {
  clientSessionId?: string;
  resumeSession?: boolean;
  appCheckToken?: string;
  /** Adapter-supplied provenance; it does not grant execution authority. */
  issuer?: 'studio';
  relaySource?: 'remote';
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
  /**
   * On the history batch a page's subscription receives first: the id the
   * host stamps on that page's events (`caller.pageId`), so the page can tell
   * its own requests from another tab's. Absent for a port that is not a page.
   */
  pageId?: string;
}

export interface RuntimeReloadMessage {
  t: 'runtime-reload';
  epoch: string;
}

/** The sandbox clock's whole state, for a port that asked to mirror it. */
interface ClockMessage {
  t: 'clock';
  state: SandboxClockState;
}

export type OutboundMessage = (
  | ResMessage
  | SnapMessage
  | EventStreamMessage
  | RuntimeReloadMessage
  | ClockMessage
) & {
  clientSessionId?: string;
};
