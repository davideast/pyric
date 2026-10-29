// The sandbox's catch-all listener. The holder routes every IPv4 and IPv6
// address to loopback (`ip route add local 0.0.0.0/0 dev lo table local`, and
// `::/0`), so a TCP connection to any address on port 80 or 443 lands here,
// whatever runtime made it. That is what records a connection by address,
// which needs no lookup and so never reaches the resolver: a Bun fetch to
// 169.254.169.254, say. Each connection is recorded as one line of the run's
// network record and reset at once, before a byte is read or written.
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { classifyHost } from './google-hosts.ts';

/** The ports the listener takes: plain and TLS web traffic. */
export const CATCH_ALL_PORTS = [80, 443];

/** An IPv4 address as a dual-stack socket reports it, without the `::ffff:` prefix. */
export function plainAddress(address) {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/** The record line for one connection that arrived at `address`:`port`. */
export function connectEvent(address, port, time = new Date()) {
  const verdict = classifyHost(plainAddress(address));
  return {
    time: time.toISOString(),
    layer: 'namespace',
    kind: 'connect',
    via: 'catch-all',
    address: verdict.host,
    port,
    host: verdict.host,
    google: verdict.google,
    catalogGap: verdict.catalogGap,
    metadata: verdict.metadata,
    ...(verdict.service ? { service: verdict.service } : {}),
    action: 'refused',
  };
}

function listenOn(port, logPath) {
  const server = net.createServer((socket) => {
    appendFileSync(logPath, `${JSON.stringify(connectEvent(socket.localAddress ?? '', socket.localPort ?? port))}\n`);
    socket.resetAndDestroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '::', ipv6Only: false }, () => resolve(server));
  });
}

/** Listens on every catch-all port; resolves the servers once all are bound. */
export function serveCatchAll(logPath) {
  return Promise.all(CATCH_ALL_PORTS.map((port) => listenOn(port, logPath)));
}
