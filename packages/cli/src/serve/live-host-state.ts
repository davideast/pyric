/**
 * The status a live host keeps and reports as the `live` field of its health
 * report: the project it was started for, the projects the app's Firebase
 * config named on its calls, and the count of billed calls. The chip and
 * Studio read it there, so they show one count however much history each
 * keeps.
 *
 * The host learns both from the observed calls its live clients send. The
 * bridge mount hands this every frame on its way to and from the Node
 * sandbox (`bridge-mount.ts`); an observed call counts once the host has
 * accepted it, so a refused frame never reaches the count. The same frames
 * name the clients connected to the host (`live-clients.ts`).
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
import { createLiveClients } from './live-clients.js';

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
  /** The `firebase/*` imports the app's installed SDK serves unwrapped and unobserved (`pyricLive({ passThrough })`). */
  passThrough?: readonly string[];
  /**
   * The `firebase/*` imports the app resolved to live rows, in the order it
   * first imported them. The app imports after the host starts, so the report
   * reads this each time: a live set, or a function that returns the list.
   */
  observed?: ObservedImportsSource;
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

/** The observed call in a frame from a client, or null for any other frame or a malformed record. */
function observedCallIn(message: BridgeMessage): { key: string; call: ObservedCall } | null {
  const isClientFrame = message.type === 'worker-message' && message.clientSessionId !== undefined;
  if (!isClientFrame) return null;
  const inner = message.message;
  const isObserve = inner.t === 'observe';
  if (!isObserve) return null;
  try {
    return { key: pendingKey(message.clientSessionId as string, inner.id), call: readObservedCall(inner.call) };
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

export function createLiveHostState(input: LiveHostStateInput): LiveHostState {
  const configSource = projectSourceName(input.configSource, input.optionName);
  const appProjectIds: string[] = [];
  const warned = new Set<string>();
  const billed = createBilledCallCounter();
  const pending = new Map<string, ObservedCall>();
  const passThrough = [...(input.passThrough ?? [])];
  const passThroughField = passThrough.length === 0 ? {} : { passThrough };
  const clients = createLiveClients(input.now ?? Date.now);

  const report = (): LiveHostStatus => ({
    projectId: liveProjectOf(appProjectIds, input.configProjectId),
    configProjectId: input.configProjectId,
    configSource,
    appProjectIds: [...appProjectIds],
    billed: billed.count(),
    ...passThroughField,
    ...observedField(input.observed),
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

  const accept = (call: ObservedCall): void => {
    noteProject(call.projectId);
    billed.addCall(call);
  };

  return {
    report,
    inbound(message) {
      clients.inbound(message);
      const observed = observedCallIn(message);
      if (observed === null) return;
      const isFull = pending.size >= MAX_PENDING_CALLS;
      if (isFull) pending.delete(pending.keys().next().value as string);
      pending.set(observed.key, observed.call);
    },
    outbound(message) {
      const reply = replyIn(message);
      if (reply === null) return;
      const call = pending.get(reply.key);
      if (call === undefined) return;
      pending.delete(reply.key);
      if (reply.ok) accept(call);
    },
  };
}
