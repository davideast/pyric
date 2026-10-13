/**
 * `pyric serve denials` against a running Node host: it reads the host's
 * repro log and lists the denials it recorded, naming each RTDB instance.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runServeDenials } from '../../src/cli/serve-denials.js';
import type { Discovered } from '../../src/serve/discovery.js';
import { HOSTED_REPRO_PATH } from '../../src/serve/hosted/method-protocol.js';

const rule = "auth != null && data.child('members').child(auth.uid).exists()";

const denial = (path: string) => ({
  __error: {
    code: 'permission-denied',
    message: "Client doesn't have permission to access the desired data.",
    denialContext: {
      engine: 'rtdb',
      auth: { uid: 'anonymous-cf1eb84b' },
      reasons: ['.read at /rooms/$roomId evaluated to false'],
      request: { method: 'listen', path },
      matchedPath: '/rooms/$roomId',
      matchedRule: rule,
    },
  },
});

/** The issue's reproduction: one room denied on the shard, one on the default instance. */
const reproFile = {
  schema: 'pyric.repro.v1',
  createdAt: '2026-10-13T00:00:00.000Z',
  recordedBy: 'test',
  truncated: false,
  base: {
    at: 0,
    checkpoint: { format: 'test', state: {} },
    databaseInstances: {},
    rules: { firestore: null, database: {}, storage: null },
    defaultInstance: 'demo-app-default-rtdb',
    permissive: false,
    appOptions: null,
    sessions: {},
    subscriptions: {},
  },
  entries: [
    { kind: 'in', at: 1_000, session: 's1', frame: { t: 'sub', subId: 'a', target: { service: 'rtdb', instance: 'demo-app-shard-1', path: '/rooms/r1' } } },
    { kind: 'out', at: 1_001, session: 's1', frame: { t: 'snap', subId: 'a', value: denial('/rooms/r1') } },
    { kind: 'in', at: 9_000, session: 's1', frame: { t: 'sub', subId: 'b', target: { service: 'rtdb', path: '/rooms/r2' } } },
    { kind: 'out', at: 9_001, session: 's1', frame: { t: 'snap', subId: 'b', value: denial('/rooms/r2') } },
  ],
};

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

async function startHost(): Promise<Discovered> {
  const server = createServer((req, res) => {
    const isRepro = req.method === 'POST' && req.url === HOSTED_REPRO_PATH;
    if (!isRepro) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reproFile)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, instanceId: 'host-1' } as Discovered;
}

async function run(argv: string[], now = 10_000) {
  const host = await startHost();
  let stdout = '';
  let stderr = '';
  const code = await runServeDenials(parseArgs(['serve', 'denials', ...argv]), {
    cwd: process.cwd(),
    stdout: { write: (value: string) => { stdout += value; } },
    stderr: { write: (value: string) => { stderr += value; } },
    discover: async () => host,
    now: () => now,
  });
  return { code, stdout, stderr };
}

describe('pyric serve denials', () => {
  it('lists each denial group with the RTDB instance it was denied on', async () => {
    const { code, stdout } = await run([]);
    expect(code).toBe(0);
    expect(stdout).toContain('rtdb demo-app-shard-1 /rooms/$roomId: 1 denial');
    expect(stdout).toContain('rtdb /rooms/$roomId: 1 denial');
    expect(stdout).toContain(`rule: ${rule}`);
    expect(stdout).toContain('identities: anonymous-cf1eb84b');
  });

  it('prints the groups as JSON, keeping only denials inside --since', async () => {
    const { code, stdout } = await run(['--json', '--since', '5s']);
    expect(code).toBe(0);
    const { denials } = JSON.parse(stdout) as { denials: Array<Record<string, unknown>> };
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ service: 'rtdb', path: '/rooms/$roomId', count: 1, firstAt: 9_001 });
    expect(denials[0]?.instance).toBeUndefined();
  });

  it('refuses an unknown --service before reading the host', async () => {
    const { code, stderr } = await run(['--service', 'functions']);
    expect(code).toBe(2);
    expect(stderr).toContain("--service is 'rtdb', 'firestore' or 'storage'");
  });
});
