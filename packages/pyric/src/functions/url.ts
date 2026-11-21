/**
 * Callable target URL resolution and off-machine URL guard (plan decisions 4 & 5).
 */
import { FunctionsError } from './errors.js';

export const DEFAULT_REGION = 'us-central1';
export const RUN_SERVICE_QUERY = '?__pyric_run_service=1';

const CLOUDFUNCTIONS_HOST = /^([a-z]+-[a-z]+\d+)-([a-z0-9-]+)\.cloudfunctions\.net$/i;
const SINGLE_SEGMENT_PATH = /^\/([^/]+)\/?$/;
const RUN_APP_LEGACY_HOST = /^([a-z0-9-]+)-[a-z0-9]+-[a-z]{2}\.a\.run\.app$/i;
const RUN_APP_REGIONAL_HOST = /^([a-z0-9-]+)-\d+\.([a-z]+-[a-z]+\d+)\.run\.app$/i;

export interface ParsedRegionOrDomain {
  region: string;
  customDomain: string | null;
}

export interface ResolvedCallableTarget {
  fetchUrl: string;
  reportedUrl: string;
}

/**
 * Parses `regionOrCustomDomain` with `@firebase/functions` 0.14.0's rule:
 * valid URLs set `customDomain` and keep `region` at `'us-central1'`; non-URL
 * strings set `region` and leave `customDomain` `null`.
 */
export function parseRegionOrCustomDomain(
  regionOrCustomDomain: string = DEFAULT_REGION,
): ParsedRegionOrDomain {
  try {
    const parsed = new URL(regionOrCustomDomain);
    let pathSuffix = parsed.pathname;
    if (pathSuffix === '/') {
      pathSuffix = '';
    }
    return {
      customDomain: `${parsed.origin}${pathSuffix}`,
      region: DEFAULT_REGION,
    };
  } catch {
    return {
      customDomain: null,
      region: regionOrCustomDomain,
    };
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function isLocalOrigin(parsed: URL, gatewayOrigin: string | null): boolean {
  if (gatewayOrigin !== null) {
    try {
      const gateway = new URL(gatewayOrigin);
      if (parsed.origin === gateway.origin) {
        return true;
      }
    } catch {
      // Ignore malformed gatewayOrigin and check loopback directly.
    }
  }
  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  return isHttp && isLoopbackHostname(parsed.hostname);
}

function offMachineError(url: string): FunctionsError {
  return new FunctionsError(
    'unavailable',
    `pyric refused off-machine callable URL '${url}'; only this project's cloudfunctions.net, run.app, and local gateway URLs are served.`,
    undefined,
    url,
  );
}

/**
 * Resolves the wire fetch URL and error-reported URL for `httpsCallable(fn, name)`.
 */
export function resolveNamedCallableTarget(input: {
  projectId: string;
  region: string;
  customDomain: string | null;
  name: string;
  gatewayOrigin: string | null;
}): ResolvedCallableTarget {
  const { projectId, region, customDomain, name, gatewayOrigin } = input;
  if (customDomain !== null) {
    const reportedUrl = `${customDomain.replace(/\/$/, '')}/${name}`;
    let parsedCustom: URL;
    try {
      parsedCustom = new URL(reportedUrl);
    } catch {
      throw offMachineError(reportedUrl);
    }
    if (!isLocalOrigin(parsedCustom, gatewayOrigin)) {
      throw offMachineError(reportedUrl);
    }
    return { fetchUrl: reportedUrl, reportedUrl };
  }

  const reportedUrl = `https://${region}-${projectId}.cloudfunctions.net/${name}`;
  if (gatewayOrigin === null || projectId.length === 0) {
    throw offMachineError(reportedUrl);
  }
  const base = gatewayOrigin.replace(/\/$/, '');
  return {
    fetchUrl: `${base}/${projectId}/${region}/${name}`,
    reportedUrl,
  };
}

/**
 * Resolves the wire fetch URL and error-reported URL for
 * `httpsCallableFromURL(fn, rawUrl)`.
 */
export function resolveUrlCallableTarget(input: {
  projectId: string;
  region: string;
  rawUrl: string;
  gatewayOrigin: string | null;
}): ResolvedCallableTarget {
  const { projectId, region, rawUrl, gatewayOrigin } = input;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw offMachineError(rawUrl);
  }

  if (isLocalOrigin(parsed, gatewayOrigin)) {
    return { fetchUrl: rawUrl, reportedUrl: rawUrl };
  }

  if (parsed.protocol !== 'https:' || gatewayOrigin === null) {
    throw offMachineError(rawUrl);
  }
  const base = gatewayOrigin.replace(/\/$/, '');

  const cfMatch = CLOUDFUNCTIONS_HOST.exec(parsed.hostname);
  const pathMatch = SINGLE_SEGMENT_PATH.exec(parsed.pathname);
  if (cfMatch !== null && pathMatch !== null) {
    const urlRegion = cfMatch[1];
    const urlProject = cfMatch[2];
    const fnName = pathMatch[1];
    if (
      urlRegion !== undefined &&
      urlProject !== undefined &&
      fnName !== undefined &&
      (projectId.length === 0 || urlProject === projectId)
    ) {
      return {
        fetchUrl: `${base}/${urlProject}/${urlRegion}/${fnName}`,
        reportedUrl: rawUrl,
      };
    }
    throw offMachineError(rawUrl);
  }

  const isRootPath = parsed.pathname === '/' || parsed.pathname === '';
  if (isRootPath && projectId.length > 0) {
    const legacyRun = RUN_APP_LEGACY_HOST.exec(parsed.hostname);
    if (legacyRun !== null && legacyRun[1] !== undefined) {
      const service = legacyRun[1].toLowerCase();
      return {
        fetchUrl: `${base}/${projectId}/${region}/${service}${RUN_SERVICE_QUERY}`,
        reportedUrl: rawUrl,
      };
    }
    const regionalRun = RUN_APP_REGIONAL_HOST.exec(parsed.hostname);
    if (
      regionalRun !== null &&
      regionalRun[1] !== undefined &&
      regionalRun[2] !== undefined
    ) {
      const service = regionalRun[1].toLowerCase();
      const runRegion = regionalRun[2].toLowerCase();
      return {
        fetchUrl: `${base}/${projectId}/${runRegion}/${service}${RUN_SERVICE_QUERY}`,
        reportedUrl: rawUrl,
      };
    }
  }

  throw offMachineError(rawUrl);
}
