/**
 * What a live Node process reads from its host at start (`reachLiveHost`):
 * the host's `firebase/*` pass-through list, and its `admin` field, which
 * says firebase-admin is observed. The Admin field never adds firebase-admin
 * to the list: live mode serves it through the Admin rows.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { reachLiveHost } from '../../src/register/live-host-reach.js';

const ADMIN = { mode: 'observed', observed: true, bypassesRules: true };
const LIVE = {
  projectId: 'demo-reach',
  configProjectId: 'demo-reach',
  configSource: '.firebaserc',
  appProjectIds: ['demo-reach'],
  billed: { reads: 0, writes: 0, deliveries: 0 },
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
});

/** The instance id the host reports, which the launcher pins (`PYRIC_SANDBOX_INSTANCE`), so the url is its own. */
const INSTANCE = 'reach-host';

/** A live host whose `/__pyric/health` reports `live`, at a loopback url. */
async function hostAnswering(live: Record<string, unknown>): Promise<string> {
  server = createServer((request, response) => {
    const isHealth = request.url === '/__pyric/health';
    response.writeHead(isHealth ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(isHealth ? { status: 'ok', mode: 'sandbox', instanceId: INSTANCE, live } : {}));
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('reachLiveHost', () => {
  test('takes the host\'s firebase/* list and its Admin field, and adds no firebase-admin', async () => {
    const url = await hostAnswering({ ...LIVE, passThrough: ['firebase/functions'], admin: ADMIN });
    const reach = await reachLiveHost(process.cwd(), { PYRIC_SANDBOX: `remote:${url}`, PYRIC_SANDBOX_INSTANCE: INSTANCE });
    expect(reach).toEqual({ kind: 'live', url, projectId: 'demo-reach', passThrough: ['firebase/functions'], admin: ADMIN });
  });

  test('reads an empty list from a host with the Admin field and nothing passed through', async () => {
    const url = await hostAnswering({ ...LIVE, admin: ADMIN });
    const reach = await reachLiveHost(process.cwd(), { PYRIC_SANDBOX: `remote:${url}`, PYRIC_SANDBOX_INSTANCE: INSTANCE });
    expect(reach.kind === 'live' ? reach.passThrough : null).toEqual([]);
  });
});
