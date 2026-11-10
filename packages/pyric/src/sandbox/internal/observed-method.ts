/**
 * One method name for an observed call, so a live row and a sandbox row name
 * the same call the same way.
 *
 * An observed event keeps the SDK export the app called as its `method`
 * (`getDoc`, `remove`, `uploadBytes`), so Traffic shows what the app wrote.
 * The sandbox's own events name the request instead (`get`, `delete`,
 * `create`). Readers that compare the two map an observed export here.
 */
import type { ObservedCallService } from '../types/observed-call.js';

/** The request a call makes, as sandbox events name it. */
export type ObservedMethod = 'get' | 'list' | 'create' | 'set' | 'update' | 'delete';

type MethodTable = Readonly<Record<string, ObservedMethod>>;

const FIRESTORE: MethodTable = {
  getDoc: 'get',
  getDocFromServer: 'get',
  getDocFromCache: 'get',
  getDocs: 'list',
  getDocsFromServer: 'list',
  getDocsFromCache: 'list',
  getCountFromServer: 'list',
  getAggregateFromServer: 'list',
  setDoc: 'set',
  updateDoc: 'update',
  deleteDoc: 'delete',
  addDoc: 'create',
};

const RTDB: MethodTable = {
  get: 'get',
  set: 'set',
  setWithPriority: 'set',
  update: 'update',
  remove: 'delete',
  push: 'create',
};

/** Every upload is a `create`, as the sandbox's Storage rules request names it. */
const STORAGE: MethodTable = {
  uploadBytes: 'create',
  uploadString: 'create',
  uploadBytesResumable: 'create',
  getDownloadURL: 'get',
  getBytes: 'get',
  getBlob: 'get',
  getStream: 'get',
  getMetadata: 'get',
  updateMetadata: 'update',
  list: 'list',
  listAll: 'list',
  deleteObject: 'delete',
};

const TABLES: Readonly<Partial<Record<ObservedCallService, MethodTable>>> = {
  firestore: FIRESTORE,
  rtdb: RTDB,
  storage: STORAGE,
};

/**
 * The method a sandbox event would name for the SDK export `method` of
 * `service`, or `null` for an export with none (a listener, a transaction, an
 * Auth, AI or Messaging call).
 */
export function observedMethod(service: ObservedCallService, method: string): ObservedMethod | null {
  const table = TABLES[service];
  const known = table !== undefined && Object.hasOwn(table, method);
  if (!known) return null;
  return table[method] ?? null;
}

function isObservedService(service: string | undefined): service is ObservedCallService {
  return service !== undefined && Object.hasOwn(TABLES, service);
}

/**
 * RTDB calls as the sandbox's event plane names them: `push` and
 * `setWithPriority` write as `set`, a removal reads `remove`, and listener
 * exports (`onValue`, `onChild*`) read as `listen`.
 */
const RTDB_ROWS: Readonly<Record<string, string>> = {
  get: 'get',
  onValue: 'listen',
  onChildAdded: 'listen',
  onChildChanged: 'listen',
  onChildRemoved: 'listen',
  onChildMoved: 'listen',
  set: 'set',
  setWithPriority: 'set',
  setPriority: 'setPriority',
  push: 'set',
  update: 'update',
  remove: 'remove',
};

/** The `firebase/database` listener exports whose deliveries report as observed RTDB reads. */
const RTDB_LISTENERS: ReadonlySet<string> = new Set(
  Object.entries(RTDB_ROWS).filter(([, row]) => row === 'listen').map(([method]) => method),
);

/** Whether `method` is a client `firebase/database` listener export (`onValue` or `onChild*`). */
export function isObservedRtdbListener(method: string): boolean {
  return RTDB_LISTENERS.has(method);
}

/**
 * The rules request an RTDB SDK export makes: `observedMethod`'s name, a
 * listener's delivery as the `get` it reads, and `setPriority` as the `set`
 * it writes; `null` for an export no rules govern (a transaction,
 * `onDisconnect`).
 */
export function rtdbRulesMethod(method: string): ObservedMethod | null {
  const direct = observedMethod('rtdb', method);
  if (direct !== null) return direct;
  if (isObservedRtdbListener(method)) return 'get';
  if (method === 'setPriority') return 'set';
  return null;
}

function rtdbRowMethod(method: string): string {
  return Object.hasOwn(RTDB_ROWS, method) ? RTDB_ROWS[method] ?? method : method;
}

/**
 * The name a sandbox row gives a live call's SDK method. Firestore reads as
 * the rules operation the host's local evaluation ran: `getDoc` is `get`,
 * `getDocs` is `list`, and `setDoc` is `create`, the case whose trace the
 * host keeps. RTDB reads as the sandbox's write plane names it, and Storage
 * as `observedMethod` does. A method with no such name reads as it is.
 */
export function rulesOperation(service: string | undefined, method: string): string {
  if (service === 'rtdb') return rtdbRowMethod(method);
  const observed = isObservedService(service) ? observedMethod(service, method) : null;
  if (observed === null) return method;
  const isFirestoreSet = service === 'firestore' && observed === 'set';
  return isFirestoreSet ? 'create' : observed;
}
