import { SandboxImpl } from './sandbox-impl.js';
import type { LocalSandbox } from '../types/service.js';

export type SandboxAdapterKind = 'shared-worker' | 'embedded';

/** Lifetime/transport seam around the one in-memory sandbox implementation. */
export interface SandboxAdapter {
  readonly kind: SandboxAdapterKind;
  create(): LocalSandbox;
}

export function createSandboxRoot(): LocalSandbox {
  return SandboxImpl.createRoot();
}

export function createSandboxAdapter(kind: SandboxAdapterKind): SandboxAdapter {
  return {
    kind,
    create: createSandboxRoot,
  };
}
