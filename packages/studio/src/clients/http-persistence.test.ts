import { afterEach, describe, expect, it } from 'bun:test';
import { bundleRecords } from 'pyric/sandbox';
import { httpPersistence } from './http-persistence.js';
import { resetSessionTokenCache } from './http-workspace.js';

const TOKEN = 'session-capability-token';
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop();
  resetSessionTokenCache();
});

interface Seen {
  method: string;
  section: string | null;
  token: string | null;
  writer: string | null;
}

/** A state route that refuses a request without the session token, as the served one does. */
function stateServer(stored: Map<string, unknown>): { baseUrl: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const isInit = url.pathname === '/__pyric/init.json';
      if (isInit) return Response.json({ sessionToken: TOKEN });
      const isState = url.pathname === '/__pyric/state';
      if (!isState) return new Response('not found', { status: 404 });
      const token = req.headers.get('x-pyric-session-token');
      seen.push({ method: req.method, section: url.searchParams.get('section'), token, writer: req.headers.get('x-pyric-writer') });
      const refused = token !== TOKEN;
      if (refused) return new Response('Unauthorized: invalid session capability token', { status: 401 });
      const isRead = req.method === 'GET';
      if (isRead) return new Response(bundleRecords(stored));
      await req.text();
      return new Response(null, { status: 204 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://localhost:${server.port}`, seen };
}

describe('httpPersistence', () => {
  it('presents the session token when it reads a section', async () => {
    const { baseUrl, seen } = stateServer(new Map([['notes/first', { title: 'Stored' }]]));
    const persistence = httpPersistence(baseUrl);

    expect(await persistence.listRecords('firestore')).toEqual(['notes/first']);
    expect(await persistence.getRecord('firestore', 'notes/first')).toEqual({ title: 'Stored' });
    expect(seen.filter((request) => request.method === 'GET').map((request) => request.token)).toEqual([TOKEN]);
  });

  it('presents the session token and its writer id when it writes and clears a section', async () => {
    const { baseUrl, seen } = stateServer(new Map());
    const persistence = httpPersistence(baseUrl);

    await persistence.putRecords('firestore', [['notes/second', { title: 'Written' }]]);
    await persistence.clear('auth');

    const writes = seen.filter((request) => request.method === 'POST');
    expect(writes.map((request) => request.section)).toEqual(['firestore', 'auth']);
    for (const write of writes) {
      expect(write.token).toBe(TOKEN);
      expect(write.writer).toMatch(/^studio-/);
    }
    expect(new Set(writes.map((write) => write.writer)).size).toBe(1);
  });
});
