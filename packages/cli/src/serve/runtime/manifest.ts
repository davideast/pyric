/** Stable routes and identity used by the served runtime and its UI. */
export const PYRIC_WORKER_URL = '/__pyric/sdk/worker.js';
export const PYRIC_WORKER_NAME = 'pyric-shared-worker';
export const PYRIC_STUDIO_URL = '/__pyric/ui/';

export interface PyricRuntimeManifest {
  studioUrl: string;
  worker: {
    url: string;
    name: string;
    /** Content epoch served by the current dev server; null in in-page mode. */
    servedEpoch: string | null;
  };
}

interface RuntimeDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

/** Read the server-stamped worker epoch before application code starts. */
export function readPyricRuntimeManifest(
  documentLike: RuntimeDocument | undefined = typeof document === 'undefined' ? undefined : document,
): PyricRuntimeManifest {
  const servedEpoch = documentLike
    ?.querySelector('meta[name="pyric-worker-v"]')
    ?.getAttribute('content')
    ?.trim() || null;

  return {
    studioUrl: PYRIC_STUDIO_URL,
    worker: {
      url: PYRIC_WORKER_URL,
      name: PYRIC_WORKER_NAME,
      servedEpoch,
    },
  };
}
