/**
 * One coordinator per local sandbox managing isolated RTDB backends per database URL.
 *
 * The database mirror and the owner controls both cross this internal seam so
 * they cannot accidentally create parallel trees for the same Sandbox and database URL.
 */
import type { Sandbox } from 'pyric/sandbox';

import { RtdbBackend } from './backend.js';
import type { JsonValue } from './data-tree.js';

export function canonicalizeDatabaseUrl(urlOrId?: string): string {
  if (!urlOrId || urlOrId.trim() === '' || urlOrId.trim().toLowerCase() === 'default') {
    return 'default';
  }
  const trimmed = urlOrId.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const u = new URL(trimmed);
      const origin = u.origin.toLowerCase();
      const pathname = u.pathname.replace(/\/+$/, '');
      const sp = new URLSearchParams();
      for (const [k, v] of u.searchParams.entries()) {
        if (k.toLowerCase() === 'ns') {
          sp.set('ns', v.toLowerCase());
        } else {
          sp.set(k, v);
        }
      }
      const searchStr = sp.toString();
      const search = searchStr ? `?${searchStr}` : '';
      return `${origin}${pathname}${search}`;
    } catch {
      return lower;
    }
  }
  return `https://${lower}.firebaseio.com`;
}

interface SandboxRtdbCoordinator {
  backends: Map<string, RtdbBackend>;
  defaultBackend?: RtdbBackend;
  listeners: Set<() => void>;
  notifyChange: () => void;
}

const coordinatorBySandbox = new WeakMap<Sandbox, SandboxRtdbCoordinator>();

export function getOrCreateBackend(sandbox: Sandbox, databaseUrl?: string): RtdbBackend {
  const canonicalUrl = canonicalizeDatabaseUrl(databaseUrl);

  let coordinator = coordinatorBySandbox.get(sandbox);
  if (!coordinator) {
    const listeners = new Set<() => void>();
    const backends = new Map<string, RtdbBackend>();
    const initialBackend = new RtdbBackend(sandbox);
    backends.set(canonicalUrl, initialBackend);

    const notifyChange = () => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // ignore
        }
      }
    };

    coordinator = {
      backends,
      defaultBackend: canonicalUrl === 'default' ? initialBackend : undefined,
      listeners,
      notifyChange,
    };
    coordinatorBySandbox.set(sandbox, coordinator);

    initialBackend.subscribeWrites(notifyChange);

    const getDefaultBackend = (): RtdbBackend => {
      let b = coordinator!.backends.get('default');
      if (!b) {
        b = new RtdbBackend(sandbox);
        coordinator!.backends.set('default', b);
        coordinator!.defaultBackend = b;
        b.subscribeWrites(notifyChange);
      }
      return b;
    };

    sandbox.onEvent((event) => {
      if (event.kind === 'session_boundary' && event.phase === 'reset') {
        for (const b of coordinator!.backends.values()) {
          b.invalidateConnectionQueues();
        }
      }
    });

    sandbox.registerPersistableService('rtdb', {
      snapshot: () => {
        const defaultState = getDefaultBackend().exportPersistenceState();
        const instances: Record<string, unknown> = {};
        for (const [url, b] of coordinator!.backends.entries()) {
          if (url !== 'default') {
            instances[url] = b.exportPersistenceState();
          }
        }
        if (
          Object.keys(instances).length > 0 &&
          defaultState !== null &&
          typeof defaultState === 'object' &&
          !Array.isArray(defaultState)
        ) {
          return {
            ...(defaultState as Record<string, unknown>),
            instances,
          };
        }
        return defaultState;
      },
      restore: (data: unknown) => {
        if (!data || typeof data !== 'object') return;
        getDefaultBackend().restoreTree(data as JsonValue);
        const record = data as { instances?: Record<string, unknown> };
        if (record.instances && typeof record.instances === 'object') {
          for (const [url, instData] of Object.entries(record.instances)) {
            const b = getOrCreateBackend(sandbox, url);
            b.restoreTree(instData as JsonValue);
          }
        }
      },
      subscribe: (onChange: () => void) => {
        listeners.add(onChange);
        return () => {
          listeners.delete(onChange);
        };
      },
      // Sandbox.resetAll: clear trees across all instances
      reset: () => {
        for (const b of coordinator!.backends.values()) {
          b.resetTree();
        }
      },
    });

    return initialBackend;
  }

  let backend = coordinator.backends.get(canonicalUrl);
  if (!backend) {
    backend = new RtdbBackend(sandbox);
    backend.subscribeWrites(coordinator.notifyChange);
    coordinator.backends.set(canonicalUrl, backend);
    if (canonicalUrl === 'default') {
      coordinator.defaultBackend = backend;
    }
  }

  return backend;
}
