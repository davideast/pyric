/**
 * One RTDB backend per local sandbox.
 *
 * The database mirror and the owner controls both cross this internal seam so
 * they cannot accidentally create parallel trees for the same Sandbox.
 */
import type { Sandbox } from 'pyric/sandbox';

import { RtdbBackend } from './backend.js';
import type { JsonValue } from './data-tree.js';

const backendBySandbox = new WeakMap<Sandbox, RtdbBackend>();

export function getOrCreateBackend(sandbox: Sandbox): RtdbBackend {
  let backend = backendBySandbox.get(sandbox);
  if (backend) return backend;

  backend = new RtdbBackend(sandbox);
  backendBySandbox.set(sandbox, backend);

  const capturedBackend = backend;
  sandbox.registerPersistableService('rtdb', {
    snapshot: () => capturedBackend.exportTree(),
    restore: (data: unknown) => {
      capturedBackend.restoreTree(data as JsonValue);
    },
    subscribe: (onChange: () => void) => capturedBackend.subscribeWrites(onChange),
    // Sandbox.resetAll: clear the whole tree (restoreTree fans listeners out,
    // so live views converge on the emptied state).
    reset: () => {
      capturedBackend.restoreTree(null);
    },
  });

  return backend;
}
