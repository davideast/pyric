/** Whether a Vite dev server serves HTTPS (#1220). */
import { Server as TlsServer } from 'node:tls';
import type { ViteDevServer } from 'vite';

/** Its server is a TLS server (`https` or `http2` secure), or its config asks for HTTPS. */
export function servesHttps(server: Pick<ViteDevServer, 'httpServer' | 'config'>): boolean {
  const isTlsServer = server.httpServer instanceof TlsServer;
  const configuresHttps = Boolean(server.config?.server?.https);
  return isTlsServer || configuresHttps;
}
