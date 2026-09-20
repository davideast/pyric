import type { EventHistoryLimits } from './event-history.js';
import { SandboxImpl } from './sandbox-impl.js';
import type { LocalSandbox } from '../types/service.js';

/** Create one isolated in-memory sandbox for any browser host. */
export function createSandboxRoot(historyLimits?: EventHistoryLimits): LocalSandbox {
  return SandboxImpl.createRoot(historyLimits);
}
