/**
 * Transforms hydrated capture events before priming `Sandbox.history()` after
 * a host or worker restart.
 *
 * Marks unfinished `pending` operation observations as `interrupted`
 * (`host-restarted`) and closes any un-detached observed live listeners from
 * the prior process with synthetic `phase: 'detach'` events so dead listeners
 * from an earlier boot never appear attached in the new session (surviving
 * browser tabs re-emit active attaches via `restoreObservedListeners` when
 * reattaching to the new host boot).
 */
import type { SandboxEvent } from '../types/index.js';

type PrimedListenerEvent = Extract<SandboxEvent, { kind: 'listener' }>;
type PrimedOperationEvent = Extract<SandboxEvent, { kind: 'operation' }>;

function isObservedLiveListenerEvent(event: SandboxEvent): event is PrimedListenerEvent {
  if (event.kind !== 'listener') return false;
  const disposition = event.rulesDisposition;
  if (disposition === undefined) return false;
  if (disposition.kind === 'not-evaluated' && disposition.reason === 'external-execution') {
    return true;
  }
  return disposition.kind === 'bypassed' && disposition.reason === 'admin';
}

function isUnfinishedOperationEvent(event: SandboxEvent): event is PrimedOperationEvent {
  return event.kind === 'operation' && event.observation?.status === 'pending';
}

export function primedHistoryEvents(events: readonly SandboxEvent[]): SandboxEvent[] {
  const primed: SandboxEvent[] = [];
  const openObservedListeners = new Map<string, PrimedListenerEvent>();
  let lastAt = 0;

  for (const event of events) {
    if (event.at > lastAt) lastAt = event.at;
    if (event.kind === 'session_boundary' && event.phase === 'reset') {
      openObservedListeners.clear();
    } else if (isObservedLiveListenerEvent(event)) {
      if (event.phase === 'attach') {
        openObservedListeners.set(event.listenerId, event);
      } else {
        openObservedListeners.delete(event.listenerId);
      }
    }

    if (isUnfinishedOperationEvent(event) && event.observation !== undefined) {
      const observation: NonNullable<PrimedOperationEvent['observation']> = {
        ...event.observation,
        status: 'interrupted',
        error: { code: 'host-restarted' },
      };
      primed.push({ ...event, observation });
    } else {
      primed.push(event);
    }
  }

  for (const attach of openObservedListeners.values()) {
    const detached: PrimedListenerEvent = {
      ...attach,
      id: `${attach.id}:host-restarted`,
      at: lastAt,
      phase: 'detach',
    };
    primed.push(detached);
  }

  return primed;
}
