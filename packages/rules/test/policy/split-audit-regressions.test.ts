// Focused regression pins for audit findings across derive expansion, Storage/split proofs,
// policy guard fatal derive output bounds, provePolicy verifySplit=false fatal parity,
// direct Storage evaluator accessor hygiene, and RTDB projected derive diagnostics.
import { describe, expect, test } from 'bun:test';
import type { Expression } from '../../src/grammar/FirestoreAST.js';
import {
  compilePolicy,
  createPolicyGuard,
  jsonBodyExtractor,
  provePolicy,
  verifySplitEnforcement,
} from '../../src/policy/index.js';
import { collectDirectCalls } from '../../src/policy/derive-project.js';
import { createStorageEvaluator } from '../../src/policy/target-evaluators.js';

describe('Policy fusion & split-proof audit regressions', () => {
  test('collectDirectCalls memoizes shared diamond DAGs in linear time', () => {
    let dag: Expression = { type: 'literal', value: 1, raw: '1' };
    for (let i = 0; i < 28; i++) {
      dag = { type: 'binaryOp', op: '+', left: dag, right: dag };
    }
    const t0 = performance.now();
    const calls = new Set<string>();
    collectDirectCalls(dag, new Map(), calls);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(calls.size).toBe(0);
  });

  test('Storage split proof checks policies without bound size while still rejecting invalid bound sizes', () => {
    const src = 'transition t { require r { return after.contentType == "image/png"; } }';
    const report = verifySplitEnforcement(src, {
      storage: { 'after.contentType': 'request.resource.contentType' },
      scenarios: [
        { name: 'allow', transition: { before: {}, after: { contentType: 'image/png' }, input: {} }, expectOk: true },
        { name: 'deny', transition: { before: {}, after: { contentType: 'text/plain' }, input: {} }, expectOk: false },
      ],
      fuzz: { enabled: true, cases: 10, seed: 7 },
    });
    expect(report.ok).toBe(true);
    expect(report.targets.storage?.ok).toBe(true);
    expect(report.targets.storage?.checked).toBeGreaterThanOrEqual(2);

    // Bound invalid sizes (-0, float, negative, >= 2^53) still return undefined (UNSUPPORTED).
    const sizeEval = createStorageEvaluator(
      ['request.resource.size >= 0'],
      { 'after.size': 'request.resource.size' },
      'create',
    )!;
    expect(sizeEval({ before: {}, after: { size: 0 }, input: {} })).toBe('ALLOW');
    for (const bad of [-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10']) {
      expect(sizeEval({ before: {}, after: { size: bad }, input: {} })).toBeUndefined();
    }
    expect(sizeEval({ before: {}, after: {}, input: {} })).toBe('DENY');
  });

  test('SplitProofAccumulator fails closed when all evaluated cases are UNSUPPORTED (checked === 0)', () => {
    const src = 'transition t { require r { return after.x > 0; } }';
    const fsReport = verifySplitEnforcement(src, {
      firestore: { 'after.x': 'request.resource.data.constructor' },
      scenarios: [{ name: 'unsupported', transition: { before: {}, after: { x: 1 }, input: {} } }],
      fuzz: { enabled: false },
    });
    expect(fsReport.targets.firestore?.checked).toBe(0);
    expect(fsReport.targets.firestore?.skippedUnsupported).toBe(1);
    expect(fsReport.targets.firestore?.ok).toBe(false);
    expect(fsReport.ok).toBe(false);

    const stReport = verifySplitEnforcement('transition t { require r { return after.size >= 0; } }', {
      storage: { 'after.size': 'request.resource.size' },
      scenarios: [{ name: 'bad-float', transition: { before: {}, after: { size: 1.5 }, input: {} } }],
      fuzz: { enabled: false },
    });
    expect(stReport.targets.storage?.checked).toBe(0);
    expect(stReport.targets.storage?.skippedUnsupported).toBe(1);
    expect(stReport.targets.storage?.ok).toBe(false);
    expect(stReport.ok).toBe(false);
  });

  test('createPolicyGuard surfaces fatal derive output depth/node bound in wrapFetch and wrapHttpHandler', async () => {
    const lets = Array.from({ length: 15 }, (_, i) => `let m${i + 1} = {'a': m${i}, 'b': m${i}};`).join('\n');
    const src = `
      use extension derive;
      transition t {
        derive {
          let m0 = {'v': 1};
          ${lets}
          return {'root': m15};
        }
        require ok { return after.ok == true; }
      }
    `;
    const body = { before: {}, after: { ok: true }, input: {} };
    for (const engine of ['interpreter', 'standalone'] as const) {
      const guard = createPolicyGuard(src, { engine, fatalStatus: 422 });
      const route = guard.wrapFetch(jsonBodyExtractor(), () => new Response('ok', { status: 200 }));
      const res = await route(new Request('https://app.example/t', { method: 'POST', body: JSON.stringify(body) }));
      expect(res.status, engine).toBe(422);
      expect(await res.json(), engine).toMatchObject({ error: 'POLICY_LIMIT_EXCEEDED', fatal: true });

      let status = 0;
      let sent = '';
      const httpHandler = guard.wrapHttpHandler(
        () => body,
        (_req, r) => {
          r.statusCode = 200;
          r.end?.('ok');
        },
      );
      await httpHandler(
        {},
        {
          statusCode: 0,
          setHeader() {},
          end(chunk?: string) {
            sent = String(chunk ?? '');
          },
          status(code: number) {
            status = code;
            return this;
          },
          json(payload: unknown) {
            sent = JSON.stringify(payload);
          },
        },
      );
      expect(status, engine).toBe(422);
      expect(JSON.parse(sent), engine).toMatchObject({ error: 'POLICY_LIMIT_EXCEEDED', fatal: true });
    }
  });

  test('provePolicy with verifySplit: false rejects DB DENY masking fatal ResourceLimitError', () => {
    const src = 'transition t { require r { return after.x > 0 && after.x > 1 && after.x > 2; } }';
    const report = provePolicy(src, {
      kind: 'transition',
      expressionLimit: 2,
      verifySplit: false,
      firestore: { 'after.x': 'request.resource.data.x' },
      rtdb: { after: 'newData' },
      storage: { 'after.x': 'request.resource.size' },
      scenarios: [{ name: 'fatal-deny', transition: { before: {}, after: { x: -1 }, input: {} } }],
      fuzz: { enabled: false },
    });
    expect(report.ok).toBe(false);
    expect(report.scenarios.failed).toBe(1);
    expect(report.scenarios.results[0]?.ok).toBe(false);
  });

  test('direct createStorageEvaluator never invokes auth.token or nested accessor getters and rejects forbidden keys', () => {
    const ev = createStorageEvaluator(
      ['request.auth != null && request.auth.uid == "u1" && request.resource.size >= 0'],
      { 'input.auth': 'request.auth', 'after.size': 'request.resource.size' },
      'create',
    )!;
    let getterHit = false;
    const token = {};
    Object.defineProperty(token, 'role', {
      enumerable: true,
      get() {
        getterHit = true;
        return 'admin';
      },
    });
    expect(ev({ before: {}, after: { size: 1 }, input: { auth: { uid: 'u1', token } } })).toBeUndefined();
    expect(getterHit).toBe(false);

    const authWithGetter = { uid: 'u1' };
    Object.defineProperty(authWithGetter, 'token', {
      enumerable: true,
      get() {
        getterHit = true;
        return {};
      },
    });
    expect(ev({ before: {}, after: { size: 1 }, input: { auth: authWithGetter } })).toBeUndefined();
    expect(getterHit).toBe(false);

    const protoTok: Record<string, unknown> = {};
    Object.defineProperty(protoTok, '__proto__', { value: { admin: true }, enumerable: true });
    expect(ev({ before: {}, after: { size: 1 }, input: { auth: { uid: 'u1', token: protoTok } } })).toBeUndefined();

    expect(ev({ before: {}, after: { size: 1 }, input: { auth: { uid: 'u1', token: { role: 'user' } } } })).toBe('ALLOW');
  });

  test('rtdb() reports expanded bindings map for projected derive reads', () => {
    const p = compilePolicy(`
      use extension derive;
      transition t {
        derive { return {'next': before.x + 1}; }
        require r { return after.x == derived.next; }
      }
    `);
    const [row] = p.rtdb({ before: 'data', after: 'newData' }, 'complete');
    expect(row!.bindings).toMatchObject({ 'before.x': 'data', 'after.x': 'newData' });
  });
});
