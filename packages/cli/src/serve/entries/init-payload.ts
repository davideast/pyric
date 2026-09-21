import { recordDiagnostic } from '../runtime/diagnostics-client.js';
import { pageListenerObservation } from '../runtime/listener-observation.js';
import type { InitPayload } from '../init-payload.js';

const hasDocument = typeof document !== 'undefined';
if (hasDocument) pageListenerObservation(document);
const documentLike = hasDocument ? document : undefined;
const hostedDeclaration = documentLike?.querySelector('meta[name="pyric-sandbox-host"]');
const requiresHostedSandbox = hostedDeclaration?.getAttribute('content') === 'node';
const expectedProjectKey = hostedDeclaration?.getAttribute('data-project-key');
const HOSTED_INIT_TIMEOUT_MS = 5_000;

/** Shared by transport selection and page initialization without a module cycle. */
export const initPayloadRequest = (async (): Promise<InitPayload> => {
  recordDiagnostic({ phase: 'init-request' });
  const abortController = new AbortController();
  let status: number | undefined;
  const deadline = requiresHostedSandbox
    ? setTimeout(() => abortController.abort(new Error(
      `/__pyric/init.json did not complete within ${HOSTED_INIT_TIMEOUT_MS} ms.`,
    )), HOSTED_INIT_TIMEOUT_MS)
    : undefined;
  try {
    const response = await fetch('/__pyric/init.json', { signal: abortController.signal });
    status = response.status;
    const hasFailedResponse = !response.ok;
    if (hasFailedResponse) throw new Error(`/__pyric/init.json → ${response.status}`);
    const payload: InitPayload = await response.json();
    const isDifferentHost = requiresHostedSandbox && payload.hosted !== true;
    if (isDifferentHost) throw new Error('/__pyric/init.json does not select the requested Node host.');
    const isDifferentProject = requiresHostedSandbox && payload.projectKey !== expectedProjectKey;
    if (isDifferentProject) throw new Error('/__pyric/init.json belongs to a different project.');
    recordDiagnostic({ phase: 'init-ready', code: status });
    return payload;
  } catch (error) {
    const phase = abortController.signal.aborted ? 'timeout' : 'init-failed';
    recordDiagnostic({ phase, code: status });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
})();

export const initPayload: Promise<InitPayload | null> = initPayloadRequest.catch((error: unknown) => {
  if (requiresHostedSandbox) {
    const isError = error instanceof Error;
    const detail = isError ? error.message : String(error);
    throw new Error(`Hosted sandbox initialization failed: ${detail}`, { cause: error });
  }
  return null;
});
