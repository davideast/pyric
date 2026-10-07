/**
 * One coordinator per local sandbox holding an isolated RTDB backend per
 * database instance, keyed by instance name.
 *
 * The database mirror and the owner controls both cross this internal seam so
 * they cannot accidentally create parallel trees for the same Sandbox and instance.
 */
import type { Sandbox } from 'pyric/sandbox';

import {
  createDatabaseInstanceRegistry,
  type DatabaseInstance,
  type DatabaseInstanceRegistry,
} from '../../sandbox/internal/instances.js';
import { RtdbBackend } from './backend.js';
import type { JsonValue } from './data-tree.js';

const registryBySandbox = new WeakMap<Sandbox, DatabaseInstanceRegistry<RtdbBackend>>();

/** The sandbox's backend for `instance`; `undefined` is the default instance. */
export function getOrCreateBackend(sandbox: Sandbox, instance?: DatabaseInstance): RtdbBackend {
  const registry = backendsFor(sandbox);
  return registry.getOrCreate(registry.keyOf(instance));
}

function backendsFor(sandbox: Sandbox): DatabaseInstanceRegistry<RtdbBackend> {
  const existing = registryBySandbox.get(sandbox);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  const notifyChange = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A persistence listener failure does not stop the others.
      }
    }
  };
  const registry = createDatabaseInstanceRegistry({
    create: () => {
      const backend = new RtdbBackend(sandbox);
      backend.subscribeWrites(notifyChange);
      return backend;
    },
  });
  registryBySandbox.set(sandbox, registry);

  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary' && event.phase === 'reset') {
      for (const [, backend] of registry.entries()) {
        backend.invalidateConnectionQueues();
        backend.setRules(null);
      }
    }
  });

  // Saved state: the default instance's state at the top level, every other
  // instance's state under `instances`, keyed by instance name.
  sandbox.registerPersistableService('rtdb', {
    snapshot: () => {
      const defaultState = registry.getOrCreate(registry.defaultKey).exportPersistenceState();
      const instances: Record<string, unknown> = {};
      for (const [key, backend] of registry.entries()) {
        if (key !== registry.defaultKey) instances[key] = backend.exportPersistenceState();
      }
      if (
        Object.keys(instances).length > 0
        && defaultState !== null
        && typeof defaultState === 'object'
        && !Array.isArray(defaultState)
      ) {
        return { ...(defaultState as Record<string, unknown>), instances };
      }
      return defaultState;
    },
    restore: (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      registry.getOrCreate(registry.defaultKey).restoreTree(data as JsonValue);
      const record = data as { instances?: Record<string, unknown> };
      if (record.instances && typeof record.instances === 'object') {
        for (const [key, state] of Object.entries(record.instances)) {
          registry.getOrCreate(key).restoreTree(state as JsonValue);
        }
      }
    },
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    // Sandbox.resetAll clears the tree of every instance.
    reset: () => {
      for (const [, backend] of registry.entries()) backend.resetTree();
    },
  });

  return registry;
}
