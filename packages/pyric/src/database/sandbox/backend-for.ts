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
import { ChangedRtdbRecords } from './persistence-records.js';

const registryBySandbox = new WeakMap<Sandbox, DatabaseInstanceRegistry<RtdbBackend>>();
const fullStateRestoreDepth = new WeakMap<Sandbox, number>();

/** Suppress transient `reset()` rule wipes while a full-state checkpoint replace is installing its ruleset. */
export async function withDatabaseRulesPreservedOnReset<T>(
  sandbox: Sandbox,
  fn: () => Promise<T>,
): Promise<T> {
  fullStateRestoreDepth.set(sandbox, (fullStateRestoreDepth.get(sandbox) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const next = (fullStateRestoreDepth.get(sandbox) ?? 1) - 1;
    if (next <= 0) fullStateRestoreDepth.delete(sandbox);
    else fullStateRestoreDepth.set(sandbox, next);
  }
}

/** The sandbox's backend for `instance`; `undefined` is the default instance. */
export function getOrCreateBackend(sandbox: Sandbox, instance?: DatabaseInstance): RtdbBackend {
  const registry = backendsFor(sandbox);
  const backend = registry.getOrCreate(registry.keyOf(instance));
  backend.markActive();
  return backend;
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
  let changedRecords: ChangedRtdbRecords | null = null;
  const registry: DatabaseInstanceRegistry<RtdbBackend> = createDatabaseInstanceRegistry({
    // A named instance's backend stamps its name on the events it emits; the
    // default instance's events carry none.
    create: (key) => {
      const instance = key === registry.defaultKey ? undefined : key;
      const backend = new RtdbBackend(sandbox, instance);
      backend.subscribeWrites(notifyChange);
      changedRecords?.attachBackend(key, backend);
      return backend;
    },
  });
  changedRecords = new ChangedRtdbRecords(registry);
  registryBySandbox.set(sandbox, registry);

  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary' && event.phase === 'reset') {
      for (const [, backend] of registry.entries()) {
        backend.invalidateConnectionQueues();
        if (!fullStateRestoreDepth.has(sandbox)) {
          backend.setRules(null);
        }
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
        if (key !== registry.defaultKey && backend.hasDurableState()) {
          instances[key] = backend.exportPersistenceState();
        }
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
      const incomingInstances =
        record.instances && typeof record.instances === 'object' && !Array.isArray(record.instances)
          ? record.instances
          : {};
      for (const [existingKey, existingBackend] of registry.entries()) {
        if (existingKey === registry.defaultKey) continue;
        if (!Object.hasOwn(incomingInstances, existingKey)) {
          existingBackend.resetTree(false);
          existingBackend.markDormant();
        }
      }
      for (const [key, state] of Object.entries(incomingInstances)) {
        const target = registry.getOrCreate(key);
        target.markActive();
        target.restoreTree(state as JsonValue);
        if (!target.hasDurableState()) {
          target.markDormant();
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
      const preserveRules = fullStateRestoreDepth.has(sandbox);
      for (const [key, backend] of registry.entries()) {
        backend.resetTree(preserveRules);
        if (key !== registry.defaultKey && !preserveRules && !backend.hasDurableState()) {
          backend.markDormant();
        }
      }
    },
    records: changedRecords,
  });

  return registry;
}

/**
 * The names of the named instances `sandbox` holds a backend for, in creation
 * order, without the default instance. Saved state is restored first, so an
 * instance only a saved session wrote to is named too.
 */
export function heldDatabaseInstances(sandbox: Sandbox): string[] {
  const registry = backendsFor(sandbox);
  return [...registry.entries()]
    .filter(([key, backend]) => key !== registry.defaultKey && !backend.isDormant())
    .map(([key]) => key);
}
