import { describe, expect, it } from 'bun:test';
import { createStorageRulesTools } from '../../src/storage/index.js';

const ctx = { signal: new AbortController().signal };

const OWNER_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

function handler(name: string) {
  const tool = createStorageRulesTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no handler ${name}`);
  return tool;
}

describe('createStorageRulesTools', () => {
  it('yields the lint and simulate handlers', () => {
    expect(createStorageRulesTools().map((tool) => tool.name)).toEqual([
      'storage_lint_rules',
      'storage_simulate_rules',
    ]);
  });

  it('lint reports a clean parse with the source size', async () => {
    const result = await handler('storage_lint_rules').execute({ source: OWNER_RULES }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ warnings: [], metrics: { sourceSize: OWNER_RULES.length } });
  });

  it('lint reports a parse error without throwing', async () => {
    const result = await handler('storage_lint_rules').execute(
      { source: "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toStartWith('Parse failed');
    expect((result.data as { parseError: { message: string } }).parseError.message).toContain(
      'parse error',
    );
  });

  it('simulate allows the owner and denies a stranger', async () => {
    const simulate = handler('storage_simulate_rules');
    const allowed = await simulate.execute(
      {
        source: OWNER_RULES,
        request: {
          auth: { uid: 'alice' },
          method: 'create',
          path: 'b/pyric-default/o/users/alice/pic.png',
          resource: { size: 10 },
        },
      },
      ctx,
    );
    expect(allowed).toMatchObject({ ok: true, summary: 'Simulation: allow', data: { allowed: true } });

    const denied = await simulate.execute(
      {
        source: OWNER_RULES,
        request: {
          auth: { uid: 'bob' },
          method: 'create',
          path: 'b/pyric-default/o/users/alice/pic.png',
          resource: { size: 10 },
        },
        resource: null,
      },
      ctx,
    );
    expect(denied).toMatchObject({ ok: true, summary: 'Simulation: deny', data: { allowed: false } });
  });

  it('simulate rejects an invalid `now` and reports a parse failure as a result', async () => {
    const simulate = handler('storage_simulate_rules');
    const request = { auth: null, method: 'get', path: 'b/pyric-default/o/users/alice/pic.png' };
    const badNow = await simulate.execute({ source: OWNER_RULES, request, now: 'yesterday' }, ctx);
    expect(badNow.ok).toBe(false);
    expect(badNow.data).toEqual({ code: 'INVALID_INPUT' });

    const badSource = await simulate.execute({ source: 'service firebase.storage {', request }, ctx);
    expect(badSource.ok).toBe(false);
    expect(badSource.summary).toStartWith('Simulation failed');
  });
});
