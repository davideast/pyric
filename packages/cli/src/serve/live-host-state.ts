/**
 * The status and host-memory session state a live host keeps:
 * - Status (`report()`): the project it was started for, the projects the app's
 *   Firebase config named on its calls, connected clients, and the count of
 *   billed calls for the chip and Studio.
 * - Session store (`sessionData`): bounded Firestore, RTDB, and Storage
 *   session deltas forwarded on accepted frames, routed through
 *   `observed-session/call-policy.ts` so local rules evaluate against
 *   authoritatively observed state and invalidate on skipped or uncaptured
 *   mutations.
 *
 * The bridge mount hands this every frame on its way to and from the Node
 * sandbox (`bridge-mount.ts`); an observed call counts and updates
 * `sessionData` only once the host has accepted it, so a refused frame never
 * reaches either. Each accepted call that production denied, an AI request it
 * rejected, or an AI answer it withheld prints a block to the host's terminal,
 * with production's message where the call carried one (`live-terminal-lines.ts`).
 * The message stays in the host: the event the Node sandbox writes holds the
 * code alone.
 *
 * Only a host a live seam started holds one: `serve/live-host.ts` for the
 * `pyric-live` command, and the Vite generation `@pyric/live/vite` starts.
 * No public option or type carries it.
 */
import {
  createBilledCallCounter,
  liveLabel,
  liveMismatchLine,
  liveProjectOf,
  readObservedCall,
  type LiveHostStatus,
} from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { BridgeMessage } from '../bridge/protocol.js';
import type { FirebaseProjectSource } from '../cli/firebase-project.js';
import type { ServedFirebaseSpecifier } from './firebase-module-swap.js';
import { createLiveClients, type SandboxClientIds } from './live-clients.js';
import { createLiveTerminalLines, type LiveCallSource, type LiveRulesFiles } from './live-terminal-lines.js';
import {
  applyAcceptedSessionCall,
  invalidateEvictedPendingCall,
} from './observed-session/call-policy.js';
import { createObservedSessionDataStore, type ObservedSessionDataStore } from './observed-session/store.js';
import { readObservedSessionDelta, skipReasonOf, type SessionDeltaSkipReason } from './observed-session/delta-validation.js';
import type { ObservedSessionDelta } from './observed-session/wire.js';
import { liveUnobservedHosts } from '../register/live-net-guard.js';

/** Observed calls waiting on the host's answer; a bound, since a client could send replies it never gets. */
const MAX_PENDING_CALLS = 4096;
/** Projects one host lists; a bound on what a client's records can grow. */
const MAX_APP_PROJECTS = 8;

export interface LiveHostState {
  /** The `live` field of the host's health report. */
  report(): LiveHostStatus;
  /** One frame on its way from the bridge to the Node sandbox. */
  inbound(message: BridgeMessage): void;
  /** One frame on its way from the Node sandbox to the bridge. */
  outbound(message: BridgeMessage): void;
  /** Name each client by the id the Node sandbox stamps on its events, once the sandbox runs (`live-clients.ts`). */
  readClientIds(lookup: SandboxClientIds): void;
  /** Name the local rules files in the production denial lines, once the session runs (`live-terminal-lines.ts`). */
  readRulesFiles(read: () => LiveRulesFiles): void;
  /** Session-scoped observed Firestore/RTDB payloads kept strictly in host memory. */
  readonly sessionData: ObservedSessionDataStore;
}

export interface LiveHostStateInput {
  /** The project the host was started for. */
  configProjectId: string;
  /** Where that project came from. */
  configSource: FirebaseProjectSource | undefined;
  /** How this host's explicit project option is written: `--project`, or the Vite plugin's `project`. */
  optionName: string;
  /** Writes a warning to the host's terminal. */
  warn(line: string): void;
  /** Writes a production denial or AI block to the host's terminal; `warn` by default. */
  print?(block: string): void;
  /** The `firebase/*` imports the app's installed SDK serves unwrapped and unobserved (`pyricLive({ passThrough })`). */
  passThrough?: readonly string[];
  /**
   * The `firebase/*` imports the app resolved to live rows, in the order it
   * first imported them. The app imports after the host starts, so the report
   * reads this each time: a live set, or a function that returns the list.
   */
  observed?: ObservedImportsSource;
  /**
   * The Google and Firebase hosts this process called that no live row
   * observed. Defaults to the process's own list (`liveUnobservedHosts`).
   */
  unobserved?: () => readonly string[];
  /** The host clock, in epoch milliseconds, for each client's last frame. `Date.now` by default. */
  now?: () => number;
}

/** Where the report reads the imports the app resolved to live rows. */
export type ObservedImportsSource = Iterable<ServedFirebaseSpecifier> | (() => Iterable<ServedFirebaseSpecifier>);

/** Where a project came from, as the developer set it. */
export function projectSourceName(source: FirebaseProjectSource | undefined, optionName: string): string {
  const names: Record<FirebaseProjectSource, string> = {
    option: optionName,
    PYRIC_PROJECT: 'PYRIC_PROJECT',
    'pyric-config': 'pyric.json',
    'firebase-use': '`firebase use`',
    firebaserc: '.firebaserc',
  };
  return source === undefined ? 'the project settings' : names[source];
}

/** The terminal line for a call to another project than the host's. */
function mismatchWarning(status: LiveHostStatus): string {
  return (
    `Live mode: your app's calls go to the Firebase project ${status.projectId}, not ${status.configProjectId}. ` +
    `${liveMismatchLine(status) ?? ''} The chip and Studio show "${liveLabel(status.projectId)}".`
  );
}

function pendingKey(clientSessionId: string, id: string): string {
  return `${clientSessionId}\u0000${id}`;
}

/** An observed call waiting on the host's answer, with the connection that sent it and its session data. */
interface PendingObservation {
  call: ObservedCall;
  clientSessionId: string;
  sessionData?: ObservedSessionDelta;
  sessionDataSkip?: SessionDeltaSkipReason;
}

/** The observed call in a frame from a client, or null for any other frame or a malformed record. */
function observedCallIn(message: BridgeMessage): { key: string; pending: PendingObservation } | null {
  const isClientFrame = message.type === 'worker-message' && message.clientSessionId !== undefined;
  if (!isClientFrame) return null;
  const inner = message.message;
  const isObserve = inner.t === 'observe';
  if (!isObserve) return null;
  const clientSessionId = message.clientSessionId as string;
  try {
    const pending: PendingObservation = { call: readObservedCall(inner.call), clientSessionId };
    if (inner.sessionData !== undefined) {
      // A malformed or oversized delta never costs the call its count: only its data is skipped.
      try {
        pending.sessionData = readObservedSessionDelta(inner.sessionData);
      } catch (err) {
        pending.sessionDataSkip = skipReasonOf(err);
      }
    }
    return { key: pendingKey(clientSessionId, inner.id), pending };
  } catch {
    // The host refuses it and names the field; nothing to count.
    return null;
  }
}

/** The pending key and outcome of a reply to a client, or null for any other frame. */
function replyIn(message: BridgeMessage): { key: string; ok: boolean } | null {
  const isReply = message.type === 'worker-message-result' && message.message.t === 'res';
  if (!isReply) return null;
  const reply = message.message as Extract<typeof message.message, { t: 'res' }>;
  return { key: pendingKey(message.clientSessionId, reply.id), ok: reply.ok };
}

/** The imports a source lists, or none when reading it throws, so the health report always answers. */
function readObserved(source: ObservedImportsSource): ServedFirebaseSpecifier[] {
  try {
    return [...new Set(typeof source === 'function' ? source() : source)];
  } catch {
    return [];
  }
}

/** The observed field of a report: each import once, in first-import order, and absent when there are none. */
function observedField(source: ObservedImportsSource | undefined): { observed?: string[] } {
  if (source === undefined) return {};
  const observed = readObserved(source);
  return observed.length === 0 ? {} : { observed };
}

/** The unobserved field of a report: each host once, and absent when there are none, so the health report always answers. */
function unobservedField(source: () => readonly string[]): { unobserved?: string[] } {
  try {
    const unobserved = [...new Set(source())];
    return unobserved.length === 0 ? {} : { unobserved };
  } catch {
    return {};
  }
}

export function createLiveHostState(input: LiveHostStateInput): LiveHostState {
  const configSource = projectSourceName(input.configSource, input.optionName);
  const appProjectIds: string[] = [];
  const warned = new Set<string>();
  const billed = createBilledCallCounter();
  const pending = new Map<string, PendingObservation>();
  const passThrough = [...(input.passThrough ?? [])];
  const passThroughField = passThrough.length === 0 ? {} : { passThrough };
  // A Node process under the live register observes firebase-admin, so every live host reports it. The host
  // sees only its own Node; a backend on Node 22 says in its own start line that its Admin rows stay shut.
  const admin: NonNullable<LiveHostStatus['admin']> = { mode: 'observed', observed: true, bypassesRules: true };
  const clients = createLiveClients(input.now ?? Date.now);
  const terminal = createLiveTerminalLines({ print: input.print ?? input.warn, now: input.now });
  const sessionData = createObservedSessionDataStore({
    projectId: input.configProjectId,
    now: input.now ?? Date.now,
  });

  const report = (): LiveHostStatus => ({
    projectId: liveProjectOf(appProjectIds, input.configProjectId),
    configProjectId: input.configProjectId,
    configSource,
    appProjectIds: [...appProjectIds],
    billed: billed.count(),
    ...passThroughField,
    ...observedField(input.observed),
    ...unobservedField(input.unobserved ?? liveUnobservedHosts),
    admin,
    ...clients.field(),
  });

  const noteProject = (projectId: string | undefined): void => {
    const isNew = projectId !== undefined && !appProjectIds.includes(projectId) && appProjectIds.length < MAX_APP_PROJECTS;
    if (!isNew) return;
    appProjectIds.push(projectId);
    const isOther = projectId !== input.configProjectId && !warned.has(projectId);
    if (!isOther) return;
    warned.add(projectId);
    input.warn(mismatchWarning(report()));
  };

  const accept = (entry: PendingObservation): void => {
    const { call, clientSessionId } = entry;
    noteProject(call.projectId);
    billed.addCall(call);
    const source: LiveCallSource | undefined = clients.sourceOf(clientSessionId);
    terminal.accepted(call, source);
    const projectHint = liveProjectOf(appProjectIds, input.configProjectId);
    applyAcceptedSessionCall(sessionData, entry, projectHint);
  };

  return {
    report,
    sessionData,
    inbound(message) {
      clients.inbound(message);
      const observed = observedCallIn(message);
      if (observed === null) return;
      const isFull = pending.size >= MAX_PENDING_CALLS;
      if (isFull) {
        const oldestKey = pending.keys().next().value as string;
        const evicted = pending.get(oldestKey);
        pending.delete(oldestKey);
        if (evicted !== undefined) {
          const projectHint = liveProjectOf(appProjectIds, input.configProjectId);
          invalidateEvictedPendingCall(sessionData, evicted.call, projectHint);
        }
      }
      pending.set(observed.key, observed.pending);
    },
    outbound(message) {
      const reply = replyIn(message);
      if (reply === null) return;
      const waiting = pending.get(reply.key);
      if (waiting === undefined) return;
      pending.delete(reply.key);
      if (reply.ok) accept(waiting);
    },
    readClientIds(lookup) {
      clients.readClientIds(lookup);
    },
    readRulesFiles(read) {
      terminal.readRulesFiles(read);
    },
  };
}
