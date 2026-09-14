import { DEFAULT_BRIDGE_PORT, DEFAULT_SANDBOX_PATH } from '../protocol.js';

/** Explicit URL, Vite injection, then the sidecar on the page's hostname. */
export function resolveBridgeUrl(explicit?: string): string {
  const hasExplicitUrl = explicit !== undefined && explicit.length > 0;
  if (hasExplicitUrl) return explicit;
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    const browserWindow = window;
    const hasInjectedUrl = '__PYRIC_BRIDGE_URL__' in browserWindow;
    if (hasInjectedUrl) {
      const injected = browserWindow.__PYRIC_BRIDGE_URL__;
      const isNonemptyUrl = typeof injected === 'string' && injected.length > 0;
      if (isNonemptyUrl) return injected;
    }
    const host = browserWindow.location.hostname || 'localhost';
    const isSecure = browserWindow.location.protocol === 'https:';
    const protocol = isSecure ? 'wss:' : 'ws:';
    return `${protocol}//${host}:${DEFAULT_BRIDGE_PORT}${DEFAULT_SANDBOX_PATH}`;
  }
  return `ws://localhost:${DEFAULT_BRIDGE_PORT}${DEFAULT_SANDBOX_PATH}`;
}

/** Try the mounted serve endpoint, then the standalone bridge endpoint. */
export function bridgeHealthUrls(url: string): string[] {
  try {
    const target = new URL(url);
    const isSecure = target.protocol === 'wss:';
    target.protocol = isSecure ? 'https:' : 'http:';
    return [`${target.origin}/__pyric/health`, `${target.origin}/health`];
  } catch {
    return [];
  }
}
