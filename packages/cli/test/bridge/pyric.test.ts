/**
 * The `pyric` verification operations and `firestore_rules.test` on the
 * composed surface.
 *
 *  1. A surface composed without credentials still lists `pyric.verify`,
 *     `pyric.verify_cases`, and `firestore_rules.test`.
 *  2. Without credentials, `pyric.verify_cases` and the sandbox engine of
 *     `pyric.verify` work; the Rules Test API paths return the explicit
 *     credentials error and never call out.
 *  3. With a scope, the handlers receive it: the Rules Test API paths
 *     resolve a token from it and call the project it names.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { FIRESTORE_TEST_RULES_SCOPE_REQUIRED } from 'pyric/rules/internal/node';
import type { ProjectScope } from '../../src/credentials/core/types.js';
import { composeMcpTools, type McpToolOp } from '../../src/bridge/server/tool-surface.js';
import { IN_PROCESS_FACTORIES } from '../../src/bridge/server/tool-factories.js';
import type { PyricVerifyFixture } from '../../src/verify/index.js';

const ALICE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

/** One captured, allowed list request by alice under ALICE_RULES. */
const FIXTURE: PyricVerifyFixture = {
  schema: 'pyric.verify.fixture.v1',
  events: [
    {
      kind: 'request',
      id: 'req-list',
      at: 1,
      evalMs: 0,
      method: 'list',
      path: 'notes',
      auth: { uid: 'alice' },
      result: 'allow',
      reasons: ['Simulated: ALLOW'],
      origin: 'user',
      detail: { query: { limit: 10 } },
    },
  ],
  services: {
    firestore: {
      rules: { format: 'firestore.rules', source: ALICE_RULES },
      state: { documents: {} },
    },
  },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer Rules Test API calls with `body`; record each URL hit. */
function stubRulesTestApi(body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return urls;
}

function fakeScope(): ProjectScope & { tokenCalls: number } {
  const scope = {
    projectId: 'fake-project',
    tokenCalls: 0,
    async resolveToken() {
      scope.tokenCalls += 1;
      return 'fake-token';
    },
  };
  return scope;
}

function op(tools: ReturnType<typeof composeMcpTools>, tool: string, name: string): McpToolOp {
  const found = tools.find((candidate) => candidate.name === tool)?.ops.find((candidate) => candidate.op === name);
  if (!found) throw new Error(`${tool}.${name} is not on the composed surface`);
  return found;
}

describe('pyric verification operations without credentials', () => {
  const tools = composeMcpTools();

  it('lists pyric.verify, pyric.verify_cases and firestore_rules.test with in-process handlers', () => {
    expect(tools.find((tool) => tool.name === 'pyric')!.ops.map((candidate) => candidate.op)).toEqual([
      'can_i_use',
      'verify',
      'verify_cases',
    ]);
    expect(op(tools, 'pyric', 'verify').handler).toBe('pyric_verify_fixture');
    expect(op(tools, 'pyric', 'verify_cases').handler).toBe('pyric_derive_rules_test_cases');
    expect(op(tools, 'firestore_rules', 'test').handler).toBe('firestore_test_rules');
    for (const candidate of [
      op(tools, 'pyric', 'verify'),
      op(tools, 'pyric', 'verify_cases'),
      op(tools, 'firestore_rules', 'test'),
    ]) {
      expect(candidate.transport).toBe('in-process');
      expect(candidate.execute).toBeFunction();
    }
  });

  it('the verify factory yields exactly the two handlers the record maps', () => {
    expect(IN_PROCESS_FACTORIES.verify().map((handler) => handler.name)).toEqual([
      'pyric_verify_fixture',
      'pyric_derive_rules_test_cases',
    ]);
  });

  it('pyric.verify_cases derives Rules Test API cases from a fixture', async () => {
    const cases = op(tools, 'pyric', 'verify_cases');
    expect(cases.validate({ fixture: FIXTURE })).toBeNull();
    const result = await cases.execute!({ fixture: FIXTURE });
    expect(result.ok).toBe(true);
    const data = result.data as { testCases: Array<{ path: string; expectation: string }> };
    expect(data.testCases).toHaveLength(1);
    expect(data.testCases[0]).toMatchObject({ path: 'notes', expectation: 'ALLOW' });
  });

  it('pyric.verify replays on the sandbox engine', async () => {
    const verify = op(tools, 'pyric', 'verify');
    expect(verify.validate({ fixture: FIXTURE, rules: { firestore: ALICE_RULES } })).toBeNull();
    const result = await verify.execute!({ fixture: FIXTURE, rules: { firestore: ALICE_RULES } });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Fixture verified');
  });

  it('pyric.verify with the rulesTestApi engine returns the credentials error and never calls out', async () => {
    const urls = stubRulesTestApi({ testResults: [{ state: 'SUCCESS' }] });
    const result = await op(tools, 'pyric', 'verify').execute!({
      fixture: FIXTURE,
      rules: { firestore: ALICE_RULES },
      engines: ['rulesTestApi'],
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('rulesTestApi engine requires a ProjectScope');
    expect(urls).toEqual([]);
  });

  it('firestore_rules.test returns the credentials error and never calls out', async () => {
    const urls = stubRulesTestApi({ testResults: [] });
    const test = op(tools, 'firestore_rules', 'test');
    expect(test.validate({ source: ALICE_RULES, testCases: [] })).toBeNull();
    const result = await test.execute!({ source: ALICE_RULES, testCases: [] });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(FIRESTORE_TEST_RULES_SCOPE_REQUIRED);
    expect(urls).toEqual([]);
  });
});

describe('pyric verification operations with a scope', () => {
  it('firestore_rules.test resolves a token from the scope and calls its project', async () => {
    const scope = fakeScope();
    const tools = composeMcpTools({ scope });
    const urls = stubRulesTestApi({ testResults: [] });
    const result = await op(tools, 'firestore_rules', 'test').execute!({
      source: ALICE_RULES,
      testCases: [],
    });
    expect(result.ok).toBe(true);
    expect(scope.tokenCalls).toBe(1);
    expect(urls).toEqual(['https://firebaserules.googleapis.com/v1/projects/fake-project:test']);
  });

  it('pyric.verify with the rulesTestApi engine resolves a token from the scope', async () => {
    const scope = fakeScope();
    const tools = composeMcpTools({ scope });
    const urls = stubRulesTestApi({ testResults: [{ state: 'SUCCESS' }] });
    const result = await op(tools, 'pyric', 'verify').execute!({
      fixture: FIXTURE,
      rules: { firestore: ALICE_RULES },
      engines: ['rulesTestApi'],
    });
    expect(result.ok).toBe(true);
    expect(scope.tokenCalls).toBe(1);
    expect(urls).toEqual(['https://firebaserules.googleapis.com/v1/projects/fake-project:test']);
  });

  it('lists the same operations with or without a scope', () => {
    const keys = (tools: ReturnType<typeof composeMcpTools>) =>
      tools.flatMap((tool) => tool.ops.map((candidate) => `${tool.name}.${candidate.op}`));
    expect(keys(composeMcpTools({ scope: fakeScope() }))).toEqual(keys(composeMcpTools()));
  });
});
