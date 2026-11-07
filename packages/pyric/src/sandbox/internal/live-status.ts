/**
 * A live host's status, so the host, the chip and Studio read it one way: the
 * project its calls go to, the warning the terminal prints when the app's
 * Firebase config names another project than the one the host was started
 * for, and the count of billed calls. The chip and Studio show the project
 * name only; the health report carries the rest.
 *
 * The host keeps the status (the `live` field of its health report) and
 * every view reads it there, so two views never disagree and a view that
 * trims its history keeps the count.
 *
 * The count is of the documents production billed for the Firestore calls it
 * answered with success, as the recorder measured them (`usage`): a query's
 * documents, a count's reads per thousand entries, a write's documents
 * written and deleted. For a listener, each document its deliveries were
 * billed for (`billedDocuments`): those added, changed or removed, at least
 * one for its first snapshot, and none for a snapshot only its metadata
 * changed. A call or delivery with no measure counts once, as does one whose
 * usage names no documents. A cache read never reaches production, and Auth
 * calls are not billed per call, so neither is counted. An aggregate counts
 * one read and a transaction one write, as their usage says. A `writeBatch`
 * commit counts each write and delete its batch held.
 */
import type { ObservedCall } from '../types/observed-call.js';
import { coverageMethodOf } from './admin-methods.js';

export type BilledCallKind = 'read' | 'write' | 'delivery';

export interface BilledCallCount {
  readonly reads: number;
  readonly writes: number;
  readonly deliveries: number;
}

/** A live host's status, as its health report carries it. Absent on a sandbox host. */
export interface LiveHostStatus {
  /** The project the app's calls go to: the projects its Firebase config named, else the host's own. */
  readonly projectId: string;
  /** The project the host was started for, from the app's Firebase project settings. */
  readonly configProjectId: string;
  /** Where the host's project came from, as a developer names it: `.firebaserc`, `firebase use`. */
  readonly configSource: string;
  /** Every project the app's Firebase config named on a call, in the order the host saw them. */
  readonly appProjectIds: readonly string[];
  readonly billed: BilledCallCount;
  /**
   * The `firebase/*` imports the app's installed SDK serves unwrapped, with no
   * row and no observer, and `firebase-admin` when a Node process under the
   * live register loads the real Admin SDK (`pyricLive({ passThrough })`).
   * Absent when there are none.
   */
  readonly passThrough?: readonly string[];
  /**
   * The `firebase/*` imports the app resolved to live rows, whose calls the
   * host observes, in the order the app first imported them. Absent when
   * there are none.
   */
  readonly observed?: readonly string[];
  /**
   * The Admin SDK a Node process under the live register loads unwrapped: its
   * calls reach production unobserved and bypass security rules. Kept apart
   * from `passThrough`. Absent when the host does not pass it through.
   */
  readonly admin?: LiveAdminStatus;
  /**
   * The clients connected to the host, one per browser profile, service
   * worker and Node process. Absent when none is connected.
   */
  readonly clients?: readonly LiveClient[];
}

/** The Admin SDK's pass-through, as a live host's health report carries it. */
export interface LiveAdminStatus {
  readonly mode: 'pass-through';
  readonly observed: false;
  readonly bypassesRules: true;
}

/** What connected to a live host: a page of a browser profile, its service worker, or a Node process. */
export type LiveClientKind = 'browser' | 'service-worker' | 'node';

/**
 * One client connected to a live host, keyed by kind and client id, so a
 * service worker is never grouped with the pages of its profile.
 */
export interface LiveClient {
  readonly kind: LiveClientKind;
  /** The browser profile's or service worker realm's client id, or the connection's own for a Node process. */
  readonly clientId: string;
  /** The path of the page the client last reported. Absent for a service worker or a Node process. */
  readonly label?: string;
  /** The uid its last observed call ran as, or null when signed out. */
  readonly user: string | null;
  /** The email of the user a browser client's page reports signed in. Absent when signed out or unknown; kept in host memory only. */
  readonly email?: string;
  /** The host time, in epoch milliseconds, of its last frame. */
  readonly lastSeen: number;
}

/** The most clients a status lists; a bound on what a host's report can grow. */
const MAX_LIVE_CLIENTS = 64;

/** What the chip and Studio show beside "pyric" for as long as the host runs: the project name. */
export function liveLabel(projectId: string): string {
  return projectId;
}

/** The projects the app's calls named that differ from the host's, or none. */
function otherProjects(status: Pick<LiveHostStatus, 'appProjectIds' | 'configProjectId'>): string[] {
  return status.appProjectIds.filter((projectId) => projectId !== status.configProjectId);
}

/**
 * The warning the terminal prints when the app's Firebase config names another
 * project than the host's: `Your Firebase config says prod; .firebaserc says
 * staging.` Null when they agree.
 */
export function liveMismatchLine(status: Pick<LiveHostStatus, 'appProjectIds' | 'configProjectId' | 'configSource'>): string | null {
  const isMismatch = otherProjects(status).length > 0;
  if (!isMismatch) return null;
  return `Your Firebase config says ${status.appProjectIds.join(', ')}; ${status.configSource} says ${status.configProjectId}.`;
}

/** The Admin SDK, which passes through only to a Node process under the live register. */
const ADMIN_SDK = 'firebase-admin';

/**
 * The start line for one passed-through import: `firebase/functions passes
 * through to production: its calls are not observed and still bill.`
 */
export function livePassThroughLine(specifier: string): string {
  if (specifier === ADMIN_SDK) {
    return `${specifier} passes through to production: its calls are not observed, bypass security rules and still bill.`;
  }
  return `${specifier} passes through to production: its calls are not observed and still bill.`;
}

/** The label's project: the projects the app's calls named, else the host's. */
export function liveProjectOf(appProjectIds: readonly string[], configProjectId: string): string {
  return appProjectIds.length === 0 ? configProjectId : appProjectIds.join(', ');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readCount(value: unknown): BilledCallCount | null {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return null;
  const reads: unknown = Reflect.get(value, 'reads');
  const writes: unknown = Reflect.get(value, 'writes');
  const deliveries: unknown = Reflect.get(value, 'deliveries');
  const isValid = isCount(reads) && isCount(writes) && isCount(deliveries);
  return isValid ? { reads, writes, deliveries } : null;
}

function isProjectName(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function readProjects(value: unknown): string[] | null {
  const isList = Array.isArray(value) && value.every(isProjectName);
  return isList ? [...(value as string[])] : null;
}

const FIREBASE_IMPORT = /^firebase\/[a-z-]+(?:\/[a-z-]+)*$/;

/** An observed import: a `firebase/*` import the app resolved to a live row. */
function isFirebaseImport(value: unknown): value is string {
  return typeof value === 'string' && FIREBASE_IMPORT.test(value);
}

/** A passed-through import: a `firebase/*` import, or `firebase-admin` itself. */
function isPassThroughImport(value: unknown): value is string {
  const isAdmin = value === ADMIN_SDK;
  return isAdmin || isFirebaseImport(value);
}

/** A list of imports: absent stays absent, and anything but a list `isImport` accepts is malformed. */
function readImports<K extends 'passThrough' | 'observed'>(
  field: K,
  value: unknown,
  isImport: (entry: unknown) => entry is string,
): Partial<Record<K, string[]>> | null {
  if (value === undefined) return {};
  const isList = Array.isArray(value) && value.every(isImport);
  return isList ? ({ [field]: [...(value as string[])] } as Partial<Record<K, string[]>>) : null;
}

const LIVE_CLIENT_KINDS: ReadonlySet<unknown> = new Set<LiveClientKind>(['browser', 'service-worker', 'node']);

function isLiveClientKind(value: unknown): value is LiveClientKind {
  return LIVE_CLIENT_KINDS.has(value);
}

function isLiveClientUser(value: unknown): value is string | null {
  return value === null || isProjectName(value);
}

/** One client entry, or null for a malformed one. */
function readClient(value: unknown): LiveClient | null {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return null;
  const kind: unknown = Reflect.get(value, 'kind');
  const clientId: unknown = Reflect.get(value, 'clientId');
  const label: unknown = Reflect.get(value, 'label');
  const user: unknown = Reflect.get(value, 'user');
  const lastSeen: unknown = Reflect.get(value, 'lastSeen');
  const email: unknown = Reflect.get(value, 'email');
  const hasLabel = label === undefined || typeof label === 'string';
  const hasEmail = email === undefined || typeof email === 'string';
  const isValid = isLiveClientKind(kind) && isProjectName(clientId) && hasLabel && isLiveClientUser(user) && hasEmail && isCount(lastSeen);
  if (!isValid) return null;
  const labelField = label === undefined ? {} : { label: label as string };
  const emailField = email === undefined ? {} : { email: email as string };
  return { kind, clientId, ...labelField, user, ...emailField, lastSeen };
}

/** The clients field: its well-formed entries, at most {@link MAX_LIVE_CLIENTS}; a malformed entry or list never loses the status. */
function readClients(value: unknown): { clients?: LiveClient[] } {
  if (!Array.isArray(value)) return {};
  const clients = value.map(readClient).filter((client): client is LiveClient => client !== null).slice(0, MAX_LIVE_CLIENTS);
  return clients.length === 0 ? {} : { clients };
}

/** The admin field: the pass-through, else absent; a malformed one never loses the status. */
function readAdmin(value: unknown): { admin?: LiveAdminStatus } {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return {};
  const isPassThrough = Reflect.get(value, 'mode') === 'pass-through';
  const isUnobserved = Reflect.get(value, 'observed') === false;
  const bypassesRules = Reflect.get(value, 'bypassesRules') === true;
  const isValid = isPassThrough && isUnobserved && bypassesRules;
  return isValid ? { admin: { mode: 'pass-through', observed: false, bypassesRules: true } } : {};
}

/** The live status in a `/__pyric/health` report, or null for a sandbox host. */
export function readLiveHostStatus(health: unknown): LiveHostStatus | null {
  const isReport = typeof health === 'object' && health !== null;
  if (!isReport) return null;
  const live: unknown = Reflect.get(health, 'live');
  const isLive = typeof live === 'object' && live !== null;
  if (!isLive) return null;
  const projectId: unknown = Reflect.get(live, 'projectId');
  const configProjectId: unknown = Reflect.get(live, 'configProjectId');
  const configSource: unknown = Reflect.get(live, 'configSource');
  const appProjectIds = readProjects(Reflect.get(live, 'appProjectIds'));
  const billed = readCount(Reflect.get(live, 'billed'));
  const passThrough = readImports('passThrough', Reflect.get(live, 'passThrough'), isPassThroughImport);
  const observed = readImports('observed', Reflect.get(live, 'observed'), isFirebaseImport);
  const hasFields = isProjectName(projectId) && isProjectName(configProjectId) && isProjectName(configSource);
  const hasLists = appProjectIds !== null && billed !== null && passThrough !== null && observed !== null;
  if (!hasFields || !hasLists) return null;
  const admin = readAdmin(Reflect.get(live, 'admin'));
  const clients = readClients(Reflect.get(live, 'clients'));
  return { projectId, configProjectId, configSource, appProjectIds, billed, ...passThrough, ...observed, ...admin, ...clients };
}

const FIRESTORE_KINDS: ReadonlyMap<string, BilledCallKind> = new Map<string, BilledCallKind>([
  ['getDoc', 'read'],
  ['getDocs', 'read'],
  ['getDocFromServer', 'read'],
  ['getDocsFromServer', 'read'],
  ['getCountFromServer', 'read'],
  ['getAggregateFromServer', 'read'],
  ['setDoc', 'write'],
  ['updateDoc', 'write'],
  ['deleteDoc', 'write'],
  ['addDoc', 'write'],
  ['runTransaction', 'write'],
  ['writeBatch.commit', 'write'],
  ['onSnapshot', 'delivery'],
  ['onSnapshotResume', 'delivery'],
]);

/**
 * The billed kind of an observed call, or null for one production did not
 * bill. An Admin call counts as the client method it reads as
 * (`coverageMethodOf`), so `DocumentReference.get` is a read and
 * `WriteBatch.commit` a write.
 */
export function billedCallKind(call: Pick<ObservedCall, 'service' | 'method' | 'outcome' | 'billedDocuments'>): BilledCallKind | null {
  const succeeded = call.outcome.status === 'ok';
  const isFirestore = call.service === 'firestore';
  if (!succeeded || !isFirestore) return null;
  const kind = FIRESTORE_KINDS.get(coverageMethodOf('firestore', call.method)) ?? null;
  const isMetadataOnly = kind === 'delivery' && call.billedDocuments === 0;
  return isMetadataOnly ? null : kind;
}

type BilledCall = Pick<ObservedCall, 'service' | 'method' | 'outcome' | 'billedDocuments' | 'usage'>;

/** The documents a call's usage names for its kind: reads for a read or delivery, writes and deletes for a write. Undefined when it names none. */
function usageUnits(kind: BilledCallKind, usage: ObservedCall['usage']): number | undefined {
  if (usage === undefined) return undefined;
  if (kind !== 'write') return usage.documentReads;
  const hasWrites = usage.documentWrites !== undefined || usage.documentDeletes !== undefined;
  return hasWrites ? (usage.documentWrites ?? 0) + (usage.documentDeletes ?? 0) : undefined;
}

/**
 * How many of its kind a billed call counts: the documents production billed
 * it for (a delivery's `billedDocuments`, else its usage), and one when the
 * recorder measured neither.
 */
function billedUnits(kind: BilledCallKind, call: BilledCall): number {
  const isDelivery = kind === 'delivery';
  const delivered = isDelivery ? call.billedDocuments : undefined;
  return delivered ?? usageUnits(kind, call.usage) ?? 1;
}

export interface BilledCallCounter {
  /** Adds `units` of `kind`, one by default. */
  add(kind: BilledCallKind, units?: number): void;
  /** Adds what an observed call was billed for, and nothing for a call production did not bill. */
  addCall(call: BilledCall): void;
  count(): BilledCallCount;
}

/** The host's running count. */
export function createBilledCallCounter(): BilledCallCounter {
  let reads = 0;
  let writes = 0;
  let deliveries = 0;
  const add = (kind: BilledCallKind, units = 1): void => {
    if (kind === 'read') reads += units;
    if (kind === 'write') writes += units;
    if (kind === 'delivery') deliveries += units;
  };
  return {
    add,
    addCall(call) {
      const kind = billedCallKind(call);
      if (kind !== null) add(kind, billedUnits(kind, call));
    },
    count: () => ({ reads, writes, deliveries }),
  };
}
