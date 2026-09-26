/** Stable routes and identity used by the served runtime and its UI. */
export const PYRIC_WORKER_URL = '/__pyric/sdk/worker.js';
export const PYRIC_WORKER_NAME = 'pyric-shared-worker';
export const PYRIC_STUDIO_URL = '/__pyric/ui/studio';

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

interface RuntimeLocation {
  href?: string;
  host?: string;
}

function resolveStudioUrl(
  documentLike?: RuntimeDocument,
  locationLike?: RuntimeLocation,
): string {
  if (typeof process !== 'undefined' && process?.env) {
    const envUrl = process.env.NEXT_PUBLIC_PYRIC_STUDIO_URL || process.env.PYRIC_STUDIO_URL;
    if (typeof envUrl === 'string' && envUrl.trim().length > 0) {
      return envUrl.trim();
    }
  }

  const init = (globalThis as {
    __PYRIC_WORKER_INIT__?: {
      studioUrl?: string;
      bridgeUrl?: string;
    };
  }).__PYRIC_WORKER_INIT__;

  if (typeof init?.studioUrl === 'string' && init.studioUrl.trim().length > 0) {
    return init.studioUrl.trim();
  }

  if (typeof init?.bridgeUrl === 'string' && init.bridgeUrl.trim().length > 0) {
    try {
      // A relative bridge URL names the page's own origin, so resolve it against the page.
      const pageHref = locationLike?.href || (typeof location !== 'undefined' ? location.href : '');
      const bridge = new URL(init.bridgeUrl, pageHref || 'http://localhost');
      const locHost = locationLike?.host || (typeof location !== 'undefined' ? location.host : '')
        || (pageHref ? new URL(pageHref).host : '');
      if (bridge.host && (!locHost || bridge.host !== locHost)) {
        const protocol = bridge.protocol === 'wss:' || bridge.protocol === 'https:' ? 'https:' : 'http:';
        return `${protocol}//${bridge.host}/__pyric/ui/studio`;
      }
    } catch {
      // Fall through on invalid bridge URL
    }
  }

  const metaStudioUrl = documentLike?.querySelector('meta[name="pyric-studio-url"]')?.getAttribute('content')?.trim()
    || documentLike?.querySelector('meta[name="pyric-runtime-chip"]')?.getAttribute('data-studio-url')?.trim();
  if (metaStudioUrl) {
    return metaStudioUrl;
  }

  return PYRIC_STUDIO_URL;
}

/** Read the server-stamped worker epoch before application code starts. */
export function readPyricRuntimeManifest(
  documentLike: RuntimeDocument | undefined = typeof document === 'undefined' ? undefined : document,
  locationLike: RuntimeLocation | undefined = typeof location === 'undefined' ? undefined : location,
): PyricRuntimeManifest {
  const servedEpoch = documentLike
    ?.querySelector('meta[name="pyric-worker-v"]')
    ?.getAttribute('content')
    ?.trim() || null;

  return {
    studioUrl: resolveStudioUrl(documentLike, locationLike),
    worker: {
      url: PYRIC_WORKER_URL,
      name: PYRIC_WORKER_NAME,
      servedEpoch,
    },
  };
}
