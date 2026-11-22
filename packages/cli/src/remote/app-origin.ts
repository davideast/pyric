import { advertisedUrl } from '../serve/advertised-host.js';

export const SANDBOX_APP_ORIGIN_ENV = 'PYRIC_SANDBOX_APP_ORIGIN';

function normalizeHttpOrigin(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    const parsed = new URL(advertisedUrl(trimmed));
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!isHttp) {
      return undefined;
    }
    return parsed.origin;
  } catch (error) {
    void error;
    return undefined;
  }
}

function selectRawAppOriginCandidate(
  explicitAppOrigin: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (explicitAppOrigin !== undefined && explicitAppOrigin.trim() !== '') {
    return explicitAppOrigin;
  }
  const nextPrivateOrigin = env.__NEXT_PRIVATE_ORIGIN;
  if (nextPrivateOrigin !== undefined && nextPrivateOrigin.trim() !== '') {
    return nextPrivateOrigin;
  }
  const configuredOrigin = env[SANDBOX_APP_ORIGIN_ENV];
  if (configuredOrigin !== undefined && configuredOrigin.trim() !== '') {
    return configuredOrigin;
  }
  const isNextProcess =
    env.__NEXT_PROCESSED_ENV === 'true' || env.NEXT_RUNTIME === 'nodejs';
  const rawPort = env.PORT;
  if (isNextProcess && rawPort !== undefined && /^\d+$/.test(rawPort.trim())) {
    const portNum = Number(rawPort.trim());
    if (portNum >= 1 && portNum <= 65535) {
      let host = 'localhost';
      if (env.HOSTNAME !== undefined && env.HOSTNAME.trim() !== '') {
        host = env.HOSTNAME.trim();
      }
      return `http://${host}:${String(portNum)}`;
    }
  }
  return undefined;
}

/**
 * Resolve the browser origin of a child application server (such as `next dev`
 * behind `withPyric`) when it differs from the sandbox host's own `serveUrl`.
 */
export function resolveConnectedAppOrigin(
  serveUrl: string,
  explicitAppOrigin?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawCandidate = selectRawAppOriginCandidate(explicitAppOrigin, env);
  if (rawCandidate === undefined) {
    return undefined;
  }
  const candidateOrigin = normalizeHttpOrigin(rawCandidate);
  if (candidateOrigin === undefined) {
    return undefined;
  }
  const hostOrigin = normalizeHttpOrigin(serveUrl);
  if (hostOrigin !== undefined && candidateOrigin === hostOrigin) {
    return undefined;
  }
  return candidateOrigin;
}

/**
 * Actionable `unavailable` guidance when no browser tab is connected to the
 * SharedWorker sandbox. Names the application's own origin when the server
 * runs on a separate port from the sandbox host (#1200).
 */
export function formatNoTabMessage(
  serveUrl: string,
  explicitAppOrigin?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const appOrigin = resolveConnectedAppOrigin(serveUrl, explicitAppOrigin, env);
  if (appOrigin === undefined) {
    return `no browser tab is connected to the sandbox \u2014 open ${serveUrl} in a browser and retry.`;
  }
  return (
    `no browser tab is connected to the sandbox - keep your app open at ${appOrigin} in a browser and retry ` +
    `(your app's SharedWorker and IndexedDB data live on ${appOrigin}, not the sandbox host ${serveUrl}).`
  );
}
