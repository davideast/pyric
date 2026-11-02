// Raw HTTP clients for scenarios that care which address a request comes from.
// Each names the local address it connects from and the Host it sends, and
// sends its target as written, which `fetch` would normalize.
import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface Answer {
  status: number;
  body: string;
}

/** An IPv4 address of this machine outside 127.0.0.0/8, or null. */
export function nonLoopbackAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      const isOtherIpv4 = entry.family === 'IPv4' && !entry.address.startsWith('127.');
      if (isOtherIpv4) return entry.address;
    }
  }
  return null;
}

/** GET `path` from `address`, sending `host` as the Host header and connecting from `localAddress`. */
export function get(input: { address: string; port: number; path: string; host: string; localAddress?: string; headers?: Record<string, string> }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: input.address,
      port: input.port,
      path: input.path,
      localAddress: input.localAddress,
      headers: { host: input.host, ...(input.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Whether the server completes a WebSocket upgrade on `path`, read from the raw response line. */
/** The status of a GET, without waiting for the body: an event stream never ends. */
export function statusOf(input: { address: string; port: number; path: string; host: string; localAddress?: string; headers?: Record<string, string> }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: input.address,
      port: input.port,
      path: input.path,
      localAddress: input.localAddress,
      headers: { host: input.host, ...(input.headers ?? {}) },
    }, (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

export function upgrades(input: { address: string; port: number; path: string; host: string; localAddress?: string; headers?: Record<string, string> }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: input.address, port: input.port, localAddress: input.localAddress });
    const finish = (opened: boolean) => {
      socket.destroy();
      resolve(opened);
    };
    socket.setTimeout(5_000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.once('data', (chunk) => finish(chunk.toString('latin1').startsWith('HTTP/1.1 101')));
    socket.write([
      `GET ${input.path} HTTP/1.1`,
      `Host: ${input.host}`,
      ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'));
  });
}

/** POST `body` from `localAddress`, naming `host`. */
export function post(input: { address: string; port: number; path: string; host: string; localAddress?: string; body: string; headers?: Record<string, string> }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({
      method: 'POST',
      host: input.address,
      port: input.port,
      path: input.path,
      localAddress: input.localAddress,
      headers: { host: input.host, 'content-type': 'application/json', ...(input.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(input.body);
  });
}
