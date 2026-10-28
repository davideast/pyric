/** The ports a page of this app may name in its Origin: the server's own, plus any proxy port it learned. */
import { describe, expect, it } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { createAppPorts } from '../../src/serve/app-ports.js';

function request(headers: Record<string, string>, localPort = 5000): IncomingMessage {
  return { headers, socket: { localPort } } as unknown as IncomingMessage;
}

describe('createAppPorts', () => {
  it('starts with the connection\'s own port', () => {
    const ports = createAppPorts('localhost');
    expect(ports.forRequest(request({}))).toEqual([5000]);
  });

  it('learns the port a proxy names in x-forwarded-host', () => {
    const ports = createAppPorts('localhost');
    ports.learn(request({ 'x-forwarded-host': '127.0.0.1:3000' }));
    expect(ports.forRequest(request({}))).toEqual([5000, 3000]);
  });

  it('learns port 80 for a forwarded host with no port', () => {
    const ports = createAppPorts('localhost');
    ports.learn(request({ 'x-forwarded-host': 'localhost' }));
    expect(ports.forRequest(request({}))).toEqual([5000, 80]);
  });

  it('ignores a forwarded host that is not loopback or the bound host', () => {
    const ports = createAppPorts('localhost');
    ports.learn(request({ 'x-forwarded-host': 'public.example:3000' }));
    ports.learn(request({ 'x-forwarded-host': 'localhost:3000, localhost:4000' }));
    ports.learn(request({ 'x-forwarded-host': 'not a host' }));
    expect(ports.forRequest(request({}))).toEqual([5000]);
  });

  it('keeps the most recent proxy ports only', () => {
    const ports = createAppPorts('localhost');
    for (let port = 3000; port < 3010; port += 1) ports.learn(request({ 'x-forwarded-host': `localhost:${port}` }));
    expect(ports.forRequest(request({}))).toEqual([5000, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009]);
  });
});
