import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { handleActivity } from '../../src/serve/activity-route.js';

const servers: Server[] = [];
const ACTIVITY_TOKEN = 'activity-test-token';
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

function incident(overrides: Partial<ActivityIncident> = {}): ActivityIncident {
  return {
    fingerprint: 'segment:0|read:get:users/alice',
    pattern: 'repeated-read',
    confidence: 'high',
    severity: 'warning',
    service: 'firestore',
    method: 'get',
    targetFingerprint: 'users/alice',
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    authUid: 'alice',
    count: 5,
    windowMs: 400,
    usage: {
      unit: 'document-reads',
      lowerBound: 5,
      limitations: [
        'Observed sandbox reads are a lower bound; production cache and billing behavior are not measured.',
      ],
    },
    evidenceEventIds: ['read-1', 'read-2'],
    sourceAttribution: 'app',
    ...overrides,
  };
}

async function startActivityServer(onIncident: (value: ActivityIncident) => void): Promise<string> {
  const server = createServer((req, res) => {
    void handleActivity(onIncident, req, res, ACTIVITY_TOKEN);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('activity route', () => {
  it('accepts generated incidents, including bounded long query identities', async () => {
    const incidents: ActivityIncident[] = [];
    const url = await startActivityServer((value) => incidents.push(value));
    const value = incident({
      fingerprint: 'f'.repeat(1_800),
      targetFingerprint: 't'.repeat(1_800),
      sourceAttribution: 'app page-1',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: url,
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body: JSON.stringify(value),
    });

    expect(response.status).toBe(204);
    expect(incidents).toEqual([value]);
  });

  it('rejects malformed, cross-origin, non-JSON, and oversized reports', async () => {
    const incidents: ActivityIncident[] = [];
    const url = await startActivityServer((value) => incidents.push(value));
    const value = incident();

    const invalid = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify({ ...value, pattern: 'made-up-pattern' }),
    });
    expect(invalid.status).toBe(400);

    const nonJson = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://attacker.example', 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify(value),
    });
    expect(nonJson.status).toBe(415);

    const forgedJson = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify(value),
    });
    expect(forgedJson.status).toBe(403);

    const missingOrigin = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify(value),
    });
    expect(missingOrigin.status).toBe(403);

    const missingCapability = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify(value),
    });
    expect(missingCapability.status).toBe(403);

    const impossible = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify({ ...value, count: -1, windowMs: 0.5 }),
    });
    expect(impossible.status).toBe(400);

    const impossibleState = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify({
        ...value,
        count: 1,
        usage: { ...value.usage, lowerBound: 1 },
        confidence: 'medium',
        severity: 'critical',
      }),
    });
    expect(impossibleState.status).toBe(400);

    for (const impossibleGeneratedState of [
      { count: 33, usage: { ...value.usage, lowerBound: 33 } },
      { windowMs: 1_001 },
    ]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: url, 'x-pyric-activity-token': ACTIVITY_TOKEN },
        body: JSON.stringify({ ...value, ...impossibleGeneratedState }),
      });
      expect(response.status).toBe(400);
    }

    for (const forgedAttribution of [
      'unattributed',
      'studio',
      `app ${'x'.repeat(200)}`,
      'app \u001b[2Jforged',
    ]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: url, 'x-pyric-activity-token': ACTIVITY_TOKEN },
        body: JSON.stringify({ ...value, sourceAttribution: forgedAttribution }),
      });
      expect(response.status).toBe(400);
    }

    const oversized = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url, 'x-pyric-activity-token': ACTIVITY_TOKEN },
      body: JSON.stringify({ ...value, padding: 'x'.repeat(33 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(incidents).toEqual([]);
  });

});
