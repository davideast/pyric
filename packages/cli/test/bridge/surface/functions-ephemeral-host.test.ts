/**
 * Mirrored unit tests for `src/bridge/surface/functions-ephemeral-host.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { request as httpRequest } from 'node:http';
import { get as getRtdb, getAdminDatabase, ref as rtdbRef } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { WebSocket } from 'ws';
import { BEACON_TOKEN_HEADER } from '../../../src/register/beacon.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';
import { BEACON_BODY_LIMIT_BYTES } from '../../../src/serve/beacon-route.js';
import { startEphemeralFunctionsHost } from '../../../src/bridge/surface/functions-ephemeral-host.js';

function rawHttp(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function probeWsAttach(
  url: string,
  headers: Record<string, string>,
): Promise<{ upgraded: boolean; ack: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { upgraded: boolean; ack: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      finish({ upgraded: false, ack: false });
    }, 3000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string };
      finish({ upgraded: true, ack: msg.type === 'attach-ack' });
      ws.close();
    });
    ws.on('error', () => {
      finish({ upgraded: false, ack: false });
    });
    ws.on('close', () => {
      finish({ upgraded: false, ack: false });
    });
  });
}

describe('startEphemeralFunctionsHost', () => {
  it('accepts authenticated remote sandbox connections, relays writes, and runs onDisconnect on close', async () => {
    const sandbox = initializeSandbox();
    const host = await startEphemeralFunctionsHost(sandbox, {
      projectId: 'demo-project',
      defaultInstance: 'custom-rtdb',
    });
    try {
      const unauthInit = await fetch(`${host.serveUrl()}/__pyric/init.json`);
      expect(unauthInit.status).toBe(401);

      const authInit = await fetch(`${host.serveUrl()}/__pyric/init.json`, {
        headers: { 'x-pyric-session-token': host.sessionToken },
      });
      expect(authInit.status).toBe(200);

      const remote = await connectRemoteSandbox({
        url: host.serveUrl(),
        instanceId: host.instanceId,
        sessionToken: host.sessionToken,
      });
      await remote.rtdb.forInstance('custom-rtdb').set('items/i1', 'written');
      await remote.channel.op({
        method: 'rtdb.onDisconnectSet',
        instance: undefined,
        path: '/presence/c1',
        value: 'gone',
        actAs: { mode: 'admin' },
      });
      remote.close();
      await host.close();

      const db = getAdminDatabase(sandbox);
      expect((await getRtdb(rtdbRef(db, 'items/i1'))).val()).toBe('written');
      expect((await getRtdb(rtdbRef(db, 'presence/c1'))).val()).toBe('gone');
    } finally {
      await host.close();
      sandbox.dispose();
    }
  });

  it('enforces loopback guards on health, init.json, beacon, and WebSocket upgrade and scopes health project to authenticated callers', async () => {
    const sandbox = initializeSandbox();
    const host = await startEphemeralFunctionsHost(sandbox, {
      projectId: 'demo-project',
      defaultInstance: 'custom-rtdb',
    });
    const port = Number(new URL(host.serveUrl()).port);
    const localHost = `127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;

    try {
      // Unauthenticated health omits project; authenticated health includes project.
      const unauthHealth = await rawHttp({
        port,
        path: '/__pyric/health',
        headers: { host: localHost },
      });
      expect(unauthHealth.status).toBe(200);
      const unauthHealthJson = JSON.parse(unauthHealth.body) as Record<string, unknown>;
      expect(unauthHealthJson.status).toBe('ok');
      expect(unauthHealthJson.instanceId).toBe(host.instanceId);
      expect('project' in unauthHealthJson).toBe(false);

      const authHealth = await rawHttp({
        port,
        path: '/__pyric/health',
        headers: { host: localHost, 'x-pyric-session-token': host.sessionToken },
      });
      expect(authHealth.status).toBe(200);
      expect((JSON.parse(authHealth.body) as Record<string, unknown>).project).toBe('demo-project');

      // Loopback guard vectors must be rejected with 403 across every HTTP route even with a valid token.
      const forbiddenVectors: Array<{ label: string; headers: Record<string, string> }> = [
        { label: 'foreign Host', headers: { host: `attacker.example:${port}` } },
        { label: 'empty Host', headers: { host: '' } },
        { label: 'foreign Origin', headers: { host: localHost, origin: 'https://attacker.example' } },
        { label: 'empty Origin', headers: { host: localHost, origin: '' } },
        { label: 'cross-scheme Origin', headers: { host: localHost, origin: `https://127.0.0.1:${port}` } },
        { label: 'sibling-port Origin', headers: { host: localHost, origin: `http://127.0.0.1:${port + 1}` } },
        { label: 'cross-site Fetch Metadata', headers: { host: localHost, 'sec-fetch-site': 'cross-site' } },
        { label: 'same-site Fetch Metadata', headers: { host: localHost, 'sec-fetch-site': 'same-site' } },
        { label: 'remote peer marker', headers: { host: localHost, 'x-pyric-remote-peer': '1' } },
      ];

      for (const vector of forbiddenVectors) {
        const healthRes = await rawHttp({
          port,
          path: '/__pyric/health',
          headers: vector.headers,
        });
        expect(healthRes.status, `health ${vector.label}`).toBe(403);

        const initRes = await rawHttp({
          port,
          path: '/__pyric/init.json',
          headers: { ...vector.headers, 'x-pyric-session-token': host.sessionToken },
        });
        expect(initRes.status, `init ${vector.label}`).toBe(403);

        const beaconRes = await rawHttp({
          port,
          method: 'POST',
          path: '/__pyric/beacon',
          headers: {
            ...vector.headers,
            'content-type': 'application/json',
            'x-pyric-session-token': host.sessionToken,
          },
          body: JSON.stringify({ pid: 123, hooks: true, sandbox: host.serveUrl() }),
        });
        expect(beaconRes.status, `beacon ${vector.label}`).toBe(403);

        const wsResult = await probeWsAttach(wsUrl, {
          ...vector.headers,
          'x-pyric-session-token': host.sessionToken,
        });
        expect(wsResult, `ws ${vector.label}`).toEqual({ upgraded: false, ack: false });
      }

      // Beacon enforces method, JSON content-type, browser markings, token auth, and body limit.
      const beaconGet = await rawHttp({
        port,
        method: 'GET',
        path: '/__pyric/beacon',
        headers: { host: localHost, 'x-pyric-session-token': host.sessionToken },
      });
      expect(beaconGet.status).toBe(405);

      const beaconWrongType = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          'content-type': 'text/plain',
          'x-pyric-session-token': host.sessionToken,
        },
        body: 'hello',
      });
      expect(beaconWrongType.status).toBe(415);

      const beaconCors = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          'content-type': 'application/json',
          'sec-fetch-mode': 'cors',
          'x-pyric-session-token': host.sessionToken,
        },
        body: '{}',
      });
      expect(beaconCors.status).toBe(403);

      const beaconSameOriginHeader = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'x-pyric-session-token': host.sessionToken,
        },
        body: '{}',
      });
      expect(beaconSameOriginHeader.status).toBe(403);

      const beaconNoToken = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: { host: localHost, 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 123, hooks: true }),
      });
      expect(beaconNoToken.status).toBe(401);

      const beaconWrongToken = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          'content-type': 'application/json',
          'x-pyric-session-token': 'wrong-token',
        },
        body: JSON.stringify({ pid: 123, hooks: true }),
      });
      expect(beaconWrongToken.status).toBe(401);

      const beaconTooLarge = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          'content-type': 'application/json',
          'x-pyric-session-token': host.sessionToken,
        },
        body: 'x'.repeat(BEACON_BODY_LIMIT_BYTES + 64),
      });
      expect(beaconTooLarge.status).toBe(413);

      const beaconAuthedSession = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          'content-type': 'application/json',
          'x-pyric-session-token': host.sessionToken,
        },
        body: JSON.stringify({ pid: 123, hooks: true, sandbox: host.serveUrl() }),
      });
      expect(beaconAuthedSession.status).toBe(204);

      const beaconAuthedHeader = await rawHttp({
        port,
        method: 'POST',
        path: '/__pyric/beacon',
        headers: {
          host: localHost,
          'content-type': 'application/json',
          [BEACON_TOKEN_HEADER]: host.sessionToken,
        },
        body: JSON.stringify({ pid: 123, hooks: true, sandbox: host.serveUrl() }),
      });
      expect(beaconAuthedHeader.status).toBe(204);

      // WebSocket upgrade rejects missing/wrong token and wrong path, accepts valid loopback + token.
      const wsNoToken = await probeWsAttach(wsUrl, { host: localHost });
      expect(wsNoToken).toEqual({ upgraded: false, ack: false });

      const wsWrongToken = await probeWsAttach(wsUrl, {
        host: localHost,
        'x-pyric-session-token': 'wrong-token',
      });
      expect(wsWrongToken).toEqual({ upgraded: false, ack: false });

      const wsWrongPath = await probeWsAttach(`ws://127.0.0.1:${port}/__pyric/other`, {
        host: localHost,
        'x-pyric-session-token': host.sessionToken,
      });
      expect(wsWrongPath).toEqual({ upgraded: false, ack: false });

      const wsValid = await probeWsAttach(wsUrl, {
        host: localHost,
        'x-pyric-session-token': host.sessionToken,
      });
      expect(wsValid).toEqual({ upgraded: true, ack: true });
    } finally {
      await host.close();
      sandbox.dispose();
    }
  });
});
