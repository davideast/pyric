// The model channel over real sockets, all on this machine: the "model API"
// is a local echo server the forwarder is pointed at, so nothing here leaves
// loopback.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectTarget, isAllowedTarget, MODEL_API, proxyEnvironment, startBridge, startModelForwarder, type Listening } from './model-channel.ts';
import { readNetworkRecord } from './recorder/network-record.ts';

const open: Listening[] = [];
afterEach(async () => {
  for (const listening of open.splice(0).reverse()) await listening.close();
});

describe('connectTarget and isAllowedTarget', () => {
  test('reads a CONNECT line and nothing else', () => {
    expect(connectTarget('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(connectTarget('CONNECT API.Anthropic.com:443 HTTP/1.0')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(connectTarget('GET http://api.anthropic.com/ HTTP/1.1')).toBeUndefined();
    expect(connectTarget('CONNECT api.anthropic.com HTTP/1.1')).toBeUndefined();
    expect(connectTarget('CONNECT user@api.anthropic.com:443 HTTP/1.1')).toBeUndefined();
  });

  test('allows the model API alone, on its own port', () => {
    expect(isAllowedTarget({ host: 'api.anthropic.com', port: 443 }, MODEL_API)).toBe(true);
    expect(isAllowedTarget({ host: 'api.anthropic.com', port: 80 }, MODEL_API)).toBe(false);
    expect(isAllowedTarget({ host: 'api.anthropic.com.evil.dev', port: 443 }, MODEL_API)).toBe(false);
    expect(isAllowedTarget({ host: 'oauth2.googleapis.com', port: 443 }, MODEL_API)).toBe(false);
    expect(isAllowedTarget(undefined, MODEL_API)).toBe(false);
  });
});

async function echoServer(): Promise<{ port: number; dialed: () => number }> {
  let dialed = 0;
  const server = net.createServer((socket) => {
    dialed += 1;
    socket.on('data', (chunk) => socket.write(`echo:${String(chunk)}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  const address = server.address() as net.AddressInfo;
  return { port: address.port, dialed: () => dialed };
}

/** Sends a CONNECT through the bridge, then `payload` once tunneled, and resolves everything read back. */
function throughBridge(port: number, target: string, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let received = '';
    socket.on('data', (chunk) => {
      received += String(chunk);
      if (received.endsWith('Established\r\n\r\n')) socket.write(payload);
      if (received.includes('echo:')) socket.end();
    });
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
  });
}

async function channel(upstreamPort: number) {
  const dir = mkdtempSync(join(tmpdir(), 'builders-channel-'));
  const networkLog = join(dir, 'network.jsonl');
  writeFileSync(networkLog, '');
  const socketPath = join(dir, 'model.sock');
  open.push(await startModelForwarder({ socketPath, networkLog, allowed: MODEL_API, upstream: { host: '127.0.0.1', port: upstreamPort } }));
  const bridge = await startBridge(socketPath);
  open.push(bridge);
  return { networkLog, bridge };
}

describe('the forwarder and the bridge', () => {
  test('tunnel a CONNECT to the model API and record it as allowed', async () => {
    const upstream = await echoServer();
    const { networkLog, bridge } = await channel(upstream.port);
    const received = await throughBridge(bridge.port, 'api.anthropic.com:443', 'ping');
    expect(received).toBe('HTTP/1.1 200 Connection Established\r\n\r\necho:ping');
    expect(readNetworkRecord(networkLog)).toEqual([expect.objectContaining({ layer: 'model-channel', host: 'api.anthropic.com', port: 443, action: 'allowed', google: false })]);
  });

  test('refuse any other target with 403, record it, and never dial', async () => {
    const upstream = await echoServer();
    const { networkLog, bridge } = await channel(upstream.port);
    const received = await throughBridge(bridge.port, 'oauth2.googleapis.com:443', 'ping');
    expect(received).toBe('HTTP/1.1 403 Forbidden\r\n\r\n');
    expect(upstream.dialed()).toBe(0);
    expect(readNetworkRecord(networkLog)).toEqual([expect.objectContaining({ host: 'oauth2.googleapis.com', action: 'refused', google: true, catalogGap: true })]);
  });
});

describe('proxyEnvironment', () => {
  test('points HTTPS at the bridge and leaves loopback direct', () => {
    expect(proxyEnvironment(4123)).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:4123', NO_PROXY: 'localhost,127.0.0.1,::1' });
  });
});
