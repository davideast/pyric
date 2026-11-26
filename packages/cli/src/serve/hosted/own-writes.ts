/**
 * Pyric's own writes under live mode. In live mode the app's Firestore and
 * Auth calls go to its Firebase project through `@pyric/live`'s rows, never
 * to this host, so every write the host is asked for comes from pyric:
 * Studio, an MCP tool, a pyric command, the seed file, or a client's pyric
 * runtime. Pyric holds no production credential and never writes on its
 * own, so a host in live mode refuses each of them before it runs, with the
 * error the installed `@pyric/live` gives (`PYRIC_LIVE_REFUSED`).
 *
 * A host is in live mode only when the one internal seam built it with that
 * refusal (`vite-supplied-entry.ts`); no option, flag or environment
 * variable sets it.
 */
import type { EventCaller } from 'pyric/sandbox';
import { sandboxToolEffect } from '../../bridge/tool-families.js';
import type { PersistedOperationMethod } from '../worker/operation-persistence.js';
import { isAiSub, type InboundMessage, type OpMessage } from '../worker/protocol.js';
import { requiresHealthyPersistence } from './persistence-admission.js';

/** Who asked the host to write: a connection's caller, a direct command, or the host's own seed. */
export type PyricWriter = EventCaller['kind'] | 'command' | 'seed';

/** A write pyric's host was asked to make. */
export interface PyricWrite {
  /** The operation, tool or command, such as `setDoc`, `firestore_set_document` or `sandbox.seed`. */
  readonly action: string;
  readonly writer: PyricWriter;
}

/** The error a live host gives for one of pyric's own writes. */
export type PyricWriteRefusal = (write: PyricWrite) => Error;

/** Throws the refusal for `write` when the host is in live mode; does nothing otherwise. */
export function refuseOwnWrite(refusal: PyricWriteRefusal | undefined, write: PyricWrite): void {
  if (refusal === undefined) return;
  throw refusal(write);
}

/** Operations omitted from durable persistence checks, classified for live-mode refusal. */
type NonPersistedOperationMethod = Exclude<OpMessage['method'], PersistedOperationMethod>;

/**
 * Exhaustive live-mode write classification for worker operations whose
 * `operationPersistence` entry is `false`. Any operation that opens upload
 * sessions, registers disconnect hooks, mutates auth/messaging/runtime state,
 * or invokes the AI broker is refused (`true`); pure reads and live client
 * presence updates remain allowed (`false`).
 */
const NON_PERSISTED_LIVE_WRITE: Readonly<Record<NonPersistedOperationMethod, boolean>> = {
  // Pure reads
  getDoc: false,
  getDocs: false,
  count: false,
  aggregate: false,
  getActiveRules: false,
  getRulesStatus: false,
  'admin.getDocument': false,
  'admin.listDocuments': false,
  'admin.readState': false,
  'rtdb.get': false,
  'sandbox.clock': false,
  'rtdb.adminSnapshot': false,
  listRootCollections: false,
  listSubcollections: false,
  'auth.getIdToken': false,
  'auth.getIdTokenResult': false,
  'auth.getCurrentUser': false,
  'auth.reload': false,
  'auth.checkActionCode': false,
  'auth.verifyPasswordResetCode': false,
  'auth.listUsers': false,
  'auth.adminGetAccountStanding': false,
  'auth.getProviderConfig': false,
  'auth.getEmailEnumerationProtection': false,
  'storage.list': false,
  'storage.listAll': false,
  'storage.getMetadata': false,
  'storage.getBlob': false,
  'storage.getBytes': false,
  getRuntimeEpoch: false,
  getVersion: false,
  exportState: false,
  listCheckpoints: false,
  getSnapshot: false,
  'crashlytics.checkForUnsentReports': false,
  'crashlytics.getState': false,
  // Live-page and Studio client presence tracking
  'presence.register': false,
  'presence.heartbeat': false,
  'presence.update': false,
  'presence.disconnect': false,
  // Non-persisted mutating or side-effecting operations
  'storage.createUploadSession': true,
  'rtdb.onDisconnectSet': true,
  'rtdb.onDisconnectUpdate': true,
  'rtdb.onDisconnectRemove': true,
  'rtdb.onDisconnectCancel': true,
  'rtdb.goOnline': true,
  'auth.signOut': true,
  'auth.setPersistence': true,
  'auth.setTenantId': true,
  'auth.updateCurrentUser': true,
  'auth.reauthenticateWithCredential': true,
  'auth.reauthenticateWithProvider': true,
  'auth.sendPasswordResetEmail': true,
  'auth.takeMail': true,
  'auth.sendSignInLinkToEmail': true,
  'auth.sendEmailVerification': true,
  'auth.verifyBeforeUpdateEmail': true,
  'auth.restorePortSession': true,
  'auth.mockSignInResult': true,
  'messaging.send': true,
  'messaging.deliver': true,
  'messaging.acknowledge': true,
  'messaging.setVisibility': true,
  'appCheck.getToken': true,
  'appCheck.getLimitedUseToken': true,
  'ai.generateContent': true,
  'ai.countTokens': true,
  retireRuntime: true,
};

function isNonPersistedLiveWrite(method: string): boolean {
  const table: Readonly<Record<string, boolean>> = NON_PERSISTED_LIVE_WRITE;
  return Object.hasOwn(table, method) && table[method] === true;
}

/**
 * The write a port's frame asks for: a durable or side-effecting operation, an
 * AI stream subscription, or a write tool, named for the refusal. Null for
 * anything else.
 */
export function portWriteOf(message: InboundMessage): string | null {
  if (message.t === 'op') {
    if (requiresHealthyPersistence(message)) return message.method;
    return isNonPersistedLiveWrite(message.method) ? message.method : null;
  }
  if (message.t === 'sub' && isAiSub(message)) return 'ai.streamGenerateContent';
  if (message.t === 'tool') return sandboxToolEffect(message.name) === 'write' ? message.name : null;
  return null;
}
