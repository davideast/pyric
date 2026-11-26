/**
 * Local egress proxy and install environment for the nightly fresh-install
 * run (`scripts/ci/fresh-install.ts`). Tunnels only to `registry.npmjs.org:443`
 * and records every request so `crashFindings` can fail on off-registry calls.
 */
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

/** The only host an install may reach, and only over TLS. */
export const REGISTRY_HOST = 'registry.npmjs.org';
export const REGISTRY_PORT = 443;

/** One request the egress guard saw: a CONNECT tunnel or a plain proxied request. */
export interface EgressEntry {
  method: string;
  host: string;
  port: number;
  allowed: boolean;
  /** When the guard saw it, as an ISO time. */
  time?: string;
}

export function isRegistryRequest(host: string, port: number): boolean {
  return host.toLowerCase() === REGISTRY_HOST && port === REGISTRY_PORT;
}

/**
 * The environment of create and install: the egress guard as the proxy and
 * the registry, and nothing else, so npm's audit and funding notices run as
 * they do for a new user. Both reach only the registry. The driver's
 * processes inherit nothing else, so these are set here, not in the workflow.
 */
export function installEnvironment(proxyUrl: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    npm_config_https_proxy: proxyUrl,
    npm_config_proxy: proxyUrl,
    npm_config_registry: `https://${REGISTRY_HOST}/`,
  };
}

function splitHostPort(authority: string): { host: string; port: number } {
  const colon = authority.lastIndexOf(':');
  if (colon === -1) {
    return { host: authority, port: 443 };
  }
  return { host: authority.slice(0, colon).replace(/^\[|\]$/g, ''), port: Number(authority.slice(colon + 1)) };
}

function tunnel(client: Socket, head: Buffer, host: string, port: number): void {
  let opened = false;
  const upstream = connect(port, host, () => {
    opened = true;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  // Before the tunnel opens the client still waits for a status line.
  upstream.on('error', () => {
    if (opened) {
      client.destroy();
    } else {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  });
  client.on('error', () => upstream.destroy());
}

/** A proxy on 127.0.0.1:`port` that tunnels only to the registry and passes every request to `record`. */
export function startEgressProxy(port: number, record: (entry: EgressEntry) => void): Promise<Server> {
  const server = createServer((request, response) => {
    // Plain HTTP never reaches the registry, which is TLS only.
    const raw = request.url ?? '';
    let target: URL | undefined;
    if (URL.canParse(raw)) {
      target = new URL(raw);
    }
    const host = target?.hostname ?? raw;
    let targetPort = 80;
    if (target?.port) {
      targetPort = Number(target.port);
    }
    record({
      method: request.method ?? 'GET',
      host,
      port: targetPort,
      allowed: false,
      time: new Date().toISOString(),
    });
    response.writeHead(403).end(`fresh-install egress guard: only https://${REGISTRY_HOST} may be reached\n`);
  });
  server.on('connect', (request, client: Socket, head: Buffer) => {
    const { host, port: targetPort } = splitHostPort(request.url ?? '');
    const allowed = isRegistryRequest(host, targetPort);
    record({ method: 'CONNECT', host, port: targetPort, allowed, time: new Date().toISOString() });
    if (allowed) {
      tunnel(client, head, host, targetPort);
    } else {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}
