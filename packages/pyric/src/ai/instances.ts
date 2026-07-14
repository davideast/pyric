/** AI handle initialization and per-owner identity. */
import {
  defaultClientApp,
  resolveClientAppIncludingDeleted,
} from '../sandbox/internal/client-app.js';
import type { FirebaseApp } from 'firebase/app';
import type { Sandbox } from '../sandbox/types/service.js';
import { Backend, BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
import { AiBroker } from './broker/broker.js';
import { TARGET_SYMBOL, isSandbox } from './target.js';
import type { AI, AIOptions, SandboxTarget } from './types.js';

const handlesByOwner = new WeakMap<Sandbox | FirebaseApp, Map<string, AI>>();
const brokersBySandbox = new WeakMap<Sandbox, AiBroker>();

function describeBackend(backend: Backend): { key: string; location: string } {
  if (backend.backendType === BackendType.VERTEX_AI) {
    const location = (backend as VertexAIBackend).location;
    return { key: `vertexai/${location}`, location };
  }
  return { key: 'googleai', location: '' };
}

function cachedHandles(owner: Sandbox | FirebaseApp): Map<string, AI> {
  let handles = handlesByOwner.get(owner);
  if (!handles) {
    handles = new Map();
    handlesByOwner.set(owner, handles);
  }
  return handles;
}

/**
 * Construct a sandbox-backed {@link AI} handle:
 *   - `getAI()` uses the default app initialized through package resolution.
 *   - `getAI(sandbox, options?)` answers through the sandbox engine.
 *   - `getAI(app, options?)` preserves `ai.app === app`.
 *
 * Repeat calls for the same owner and backend return a stable handle; the
 * first call's options win.
 */
export function getAI(sandbox: Sandbox, options?: AIOptions): AI;
export function getAI(app?: FirebaseApp, options?: AIOptions): import('./types.js').AppAI;
export function getAI(target?: Sandbox | FirebaseApp, options?: AIOptions): AI {
  if (target === undefined) {
    return getAI(defaultClientApp() as FirebaseApp, options);
  }
  const appRuntime = resolveClientAppIncludingDeleted(target);
  if (appRuntime) {
    return sandboxAI(appRuntime.sandbox, options, target as FirebaseApp);
  }
  if (isSandbox(target)) {
    return sandboxAI(target, options);
  }
  throw new TypeError(
    'pyric/ai is a sandbox-only mirror. Package resolution must leave firebase/ai unchanged for production; activate pyric dev or @pyric/cli/register before importing to select the sandbox.',
  );
}

function sandboxAI(sandbox: Sandbox, options?: AIOptions, app?: FirebaseApp): AI {
  const backend = options?.backend ?? new GoogleAIBackend();
  const { key, location } = describeBackend(backend);
  const handles = cachedHandles(app ?? sandbox);
  const existing = handles.get(key);
  if (existing) return existing;

  let broker = brokersBySandbox.get(sandbox);
  if (!broker) {
    broker = new AiBroker({ engine: options?.engine, sandbox });
    brokersBySandbox.set(sandbox, broker);
  }
  const handle: AI = {
    ...(app !== undefined ? { app } : {}),
    backend,
    location,
    ...(options !== undefined ? { options } : {}),
  };
  const appRuntime = app === undefined
    ? undefined
    : resolveClientAppIncludingDeleted(app);
  const target: SandboxTarget = {
    kind: 'sandbox',
    sandbox,
    broker,
    ...(appRuntime !== undefined
      ? { assertAlive: () => appRuntime.assertAlive() }
      : {}),
  };
  Object.defineProperty(handle, TARGET_SYMBOL, { value: target, enumerable: false });
  handles.set(key, handle);
  return handle;
}
