import { describe, expect, test } from 'bun:test';
import {
  createRtdbInspectRulesTool,
  inspectDeployedRtdbRules,
} from '../../src/rtdb/inspect-deployed-rules.js';

const DATABASE_URL = 'https://demo-default-rtdb.firebaseio.com';
const RULES_URL = `${DATABASE_URL}/.settings/rules.json`;
const scope = { projectId: 'demo', resolveToken: async () => 'token-value' };

const DEPLOYED = {
  rules: {
    '.read': false,
    posts: {
      $id: { '.read': 'auth != null', '.write': 'auth.uid === $id', '.validate': 'newData.isString()' },
    },
    items: { '.indexOn': ['ts'] },
  },
};

interface Recorded {
  url: string;
  method: string;
}

/** A fetch that fails the test on any request that is not a GET of the rules settings URL. */
function readOnlyFetch(respond: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method !== 'GET') throw new Error(`forbidden method ${method}`);
    if (url !== RULES_URL) throw new Error(`forbidden url ${url}`);
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

async function inspect(local: string, response: () => Response) {
  const { fetchImpl, calls } = readOnlyFetch(response);
  const result = await inspectDeployedRtdbRules({
    scope,
    databaseURL: DATABASE_URL,
    localRulesText: local,
    fetchImpl,
  });
  return { result, calls };
}

describe('inspectDeployedRtdbRules', () => {
  test('a changed .write at one path reports exactly one change', async () => {
    const local = JSON.stringify({
      rules: {
        ...DEPLOYED.rules,
        posts: { $id: { ...DEPLOYED.rules.posts.$id, '.write': 'false' } },
      },
    });
    const { result, calls } = await inspect(local, () => json(DEPLOYED));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff).toEqual([
      { path: '/posts/$id', kind: '.write', change: 'changed', deployed: 'auth.uid === $id', local: 'false' },
    ]);
    expect(result.deployed).toEqual(DEPLOYED);
    expect(calls).toEqual([{ url: RULES_URL, method: 'GET' }]);
  });

  test('an identical ruleset reports no changes', async () => {
    const { result } = await inspect(JSON.stringify(DEPLOYED), () => json(DEPLOYED));
    expect(result.ok && result.diff).toEqual([]);
  });

  test('commented local rules diff correctly, and a commented deployed body parses', async () => {
    const local = `{
      // owner-only writes
      "rules": {
        ".read": false, /* closed by default */
        "posts": { "$id": {
          ".read": "auth != null", ".write": "auth.uid === $id", ".validate": "newData.isString()"
        } },
        "items": { ".indexOn": ["ts"] },
        "extra": { ".read": true }
      }
    }`;
    const deployedText = `// deployed\n${JSON.stringify(DEPLOYED)}`;
    const { result } = await inspect(local, () => json(deployedText));
    expect(result.ok && result.diff).toEqual([
      { path: '/extra', kind: '.read', change: 'added', local: 'true' },
    ]);
  });

  test('reports removed expressions and changed .indexOn', async () => {
    const local = JSON.stringify({ rules: { '.read': false, items: { '.indexOn': ['ts', 'owner'] } } });
    const { result } = await inspect(local, () => json(DEPLOYED));
    expect(result.ok && result.diff).toEqual([
      { path: '/items', kind: '.indexOn', change: 'changed', deployed: '["ts"]', local: '["ts","owner"]' },
      { path: '/posts/$id', kind: '.read', change: 'removed', deployed: 'auth != null' },
      { path: '/posts/$id', kind: '.validate', change: 'removed', deployed: 'newData.isString()' },
      { path: '/posts/$id', kind: '.write', change: 'removed', deployed: 'auth.uid === $id' },
    ]);
  });

  for (const status of [401, 403]) {
    test(`${status} reports the credential fix and never prints the token`, async () => {
      const { result, calls } = await inspect(JSON.stringify(DEPLOYED), () => json({ error: 'denied' }, status));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(status === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED');
      expect(result.error.message).toContain('FIREBASE_SA_BASE64');
      expect(result.error.message).toContain('GOOGLE_APPLICATION_CREDENTIALS');
      expect(result.error.message).toContain('Firebase Realtime Database Viewer');
      expect(JSON.stringify(result)).not.toContain('token-value');
      expect(calls).toHaveLength(1);
    });
  }

  test('sends the token as a header, not in the URL', async () => {
    let seen: RequestInit | undefined;
    let seenUrl = '';
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seen = init;
      return json(DEPLOYED);
    }) as typeof fetch;
    await inspectDeployedRtdbRules({
      scope,
      databaseURL: `${DATABASE_URL}/`,
      localRulesText: JSON.stringify(DEPLOYED),
      fetchImpl,
    });
    expect(seenUrl).toBe(RULES_URL);
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer token-value');
    expect(seen?.method).toBe('GET');
  });

  test('invalid local rules report a parse failure without any request', async () => {
    const { result, calls } = await inspect('{ not json', () => json(DEPLOYED));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_LOCAL_RULES');
    expect(calls).toHaveLength(0);
  });
});

describe('createRtdbInspectRulesTool', () => {
  test('is named rtdb_inspect_rules and summarizes drift', async () => {
    const { fetchImpl } = readOnlyFetch(() => json(DEPLOYED));
    const tool = createRtdbInspectRulesTool({
      scope,
      databaseURL: DATABASE_URL,
      readLocalRules: () => JSON.stringify({ rules: { '.read': true } }),
      fetchImpl,
    });
    expect(tool.name).toBe('rtdb_inspect_rules');
    const out = await tool.execute({});
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/differ/);
  });
});
