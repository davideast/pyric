import { SandboxImpl } from './sandbox-impl.js';
import type { LocalSandbox } from '../types/service.js';

/** Create one isolated in-memory sandbox for any browser host. */
export function createSandboxRoot(): LocalSandbox {
  return SandboxImpl.createRoot();
}
