/**
 * Local HTTP keep-alive timeouts for Pyric's Node servers (`startStaticServer`,
 * `startStandaloneBridge`, `startFunctionsEphemeralHost`).
 *
 * Node's `http.Server` defaults to `keepAliveTimeout = 5_000` ms. Dev-server
 * reverse proxies (`withPyric` Next.js rewrites, Vite `server.proxy`) pool
 * idle upstream sockets in `http.Agent` well past 5 seconds; when a page
 * compile spans ~5s after an initial `/__pyric/init.json` probe, reusing that
 * pooled socket right as the 5s timer closes it fails `/__pyric/sdk/worker.js`
 * with `ECONNRESET` (#1279, #1589). Keeping `keepAliveTimeout` at 65s (and
 * `headersTimeout` strictly above it at 66s) outlives reverse-proxy idle
 * socket pools, while `closeAllConnections()` on shutdown still stops cleanly.
 */

export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;

export interface KeepAliveConfigurableServer {
  keepAliveTimeout: number;
  headersTimeout: number;
}

export function configureLocalHttpKeepAlive<T extends KeepAliveConfigurableServer>(server: T): T {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  return server;
}
