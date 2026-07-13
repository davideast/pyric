/** AI handle initialization and per-owner identity. */
import {
  getDefaultSandboxApp,
  isSandboxApp,
  type SandboxApp,
} from '../sandbox/internal/app-handle.js';
import type { Sandbox } from '../sandbox/types/service.js';
import { Backend, BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
import { AiBroker } from './broker/broker.js';
import { TARGET_SYMBOL, isSandbox } from './target.js';
import type { AI, AIOptions, SandboxTarget } from './types.js';

const sandboxHandles = new WeakMap<Sandbox, Map<string, AI>>();
const appHandles = new WeakMap<SandboxApp, Map<string, AI>>();

function backendKey(backend: Backend): string {
  return backend.backendType === BackendType.VERTEX_AI
    ? `vertexai/${(backend as VertexAIBackend).location}`
    : 'googleai';
}

function cachedHandles<K extends object>(
  cache: WeakMap<K, Map<string, AI>>,
  owner: K,
): Map<string, AI> {
  let handles = cache.get(owner);
  if (!handles) {
    handles = new Map();
    cache.set(owner, handles);
  }
  return handles;
}

function handlesFor(owner: Sandbox | SandboxApp): Map<string, AI> {
  return isSandboxApp(owner)
    ? cachedHandles(appHandles, owner)
    : cachedHandles(sandboxHandles, owner);
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
export function getAI(app?: SandboxApp, options?: AIOptions): AI;
export function getAI(target?: Sandbox | SandboxApp, options?: AIOptions): AI {
  if (target === undefined) {
    return getAI(getDefaultSandboxApp(), options);
  }
  if (isSandboxApp(target)) {
    return sandboxAI(target.sandbox, options, target);
  }
  if (isSandbox(target)) {
    return sandboxAI(target, options);
  }
  throw new TypeError(
    'pyric/ai is a sandbox-only mirror. Package resolution must leave firebase/ai unchanged for production; activate pyric dev or @pyric/cli/register before importing to select the sandbox.',
  );
}

function sandboxAI(sandbox: Sandbox, options?: AIOptions, app?: SandboxApp): AI {
  const backend = options?.backend ?? new GoogleAIBackend();
  const key = backendKey(backend);
  const handles = handlesFor(app ?? sandbox);
  const existing = handles.get(key);
  if (existing) return existing;

  const broker = new AiBroker({ engine: options?.engine, sandbox });
  const handle: AI = {
    ...(app !== undefined ? { app } : {}),
    backend,
    ...(options !== undefined ? { options } : {}),
  };
  const target: SandboxTarget = { sandbox, broker };
  Object.defineProperty(handle, TARGET_SYMBOL, { value: target, enumerable: false });
  handles.set(key, handle);
  return handle;
}
