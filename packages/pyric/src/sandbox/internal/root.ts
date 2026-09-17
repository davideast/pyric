import type { EventHistoryLimits } from './event-history.js';
import { SandboxImpl } from './sandbox-impl.js';
import type { LocalSandbox } from '../types/service.js';

/** Create one isolated in-memory sandbox for any browser host. */
export function createSandboxRoot(historyLimits?: EventHistoryLimits): LocalSandbox {
  return SandboxImpl.createRoot(historyLimits);
}

/** Hosted adapters install durable engine history after state restoration. */
export function installHostedHistory(sandbox: LocalSandbox, store: import('../../firestore/sandbox/event-log.js').AgentEventStore, observe?: (event: import('../types/events.js').SandboxEvent) => void) {
  const local = sandbox instanceof SandboxImpl;
  const notLocal = !local;
  if (notLocal) throw new Error('Hosted history requires a local sandbox root.');
  return sandbox.installHistoryStore(store, observe);
}
