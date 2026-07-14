/** Internal adapter seam for transport-backed AI handles. */
import type { FirebaseApp } from 'firebase/app';
import { BackendType, GoogleAIBackend, VertexAIBackend } from './backend.js';
import type { AnswerEngine } from './broker/types.js';
import { TARGET_SYMBOL } from './target.js';
import type { AI, AIOptions, TransportTarget } from './types.js';

export { aiErrorFromEnvelope } from './errors.js';

const transportHandles = new WeakMap<FirebaseApp, Map<string, AI>>();

function backendKey(options?: AIOptions): { key: string; location: string } {
  const backend = options?.backend ?? new GoogleAIBackend();
  if (backend.backendType === BackendType.VERTEX_AI) {
    const location = (backend as VertexAIBackend).location;
    return { key: `vertexai/${location}`, location };
  }
  return { key: 'googleai', location: '' };
}

/**
 * Create an app-shaped AI handle whose operations go straight to an adapter
 * transport. Unlike {@link getAI}, this never creates a page-local sandbox or
 * {@link AiBroker}; the remote runtime remains the only semantic broker and
 * the only source of AI operation events.
 */
export function createTransportAI(
  app: FirebaseApp,
  options: AIOptions | undefined,
  transport: AnswerEngine,
  assertAlive?: () => void,
): AI {
  const { key, location } = backendKey(options);
  let handles = transportHandles.get(app);
  if (!handles) {
    handles = new Map();
    transportHandles.set(app, handles);
  }
  const existing = handles.get(key);
  if (existing) return existing;

  const backend = options?.backend ?? new GoogleAIBackend();
  const handle: AI = {
    app,
    backend,
    location,
    ...(options !== undefined ? { options } : {}),
  };
  const target: TransportTarget = {
    kind: 'transport',
    transport,
    ...(assertAlive !== undefined ? { assertAlive } : {}),
  };
  Object.defineProperty(handle, TARGET_SYMBOL, { value: target, enumerable: false });
  handles.set(key, handle);
  return handle;
}
