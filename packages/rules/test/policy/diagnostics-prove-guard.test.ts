import { describe, expect, test } from 'bun:test';
import {
  compileFunction,
  compilePolicy,
  createPolicyGuard,
  detectPolicyKind,
  instantiateStandaloneModule,
  jsonBodyExtractor,
  PolicyDeniedError,
  PolicyPayloadTooLargeError,
  provePolicy,
  type HttpLikeRequest,
  type HttpLikeResponse,
} from '../../src/policy/index.js';

const ORDER_POLICY = `
  use extension derive;
  use extension bounded;
  transition checkout {
    derive {
      let itemTotal = bounded.fold(input.items, 0, (acc, item) => acc + item.price, 8);
      let tax = itemTotal / 10;
      return {'subtotal': itemTotal, 'total': itemTotal + tax};
    }
    require positiveItems {
      let allPos = bounded.all(input.items, item => item.price > 0, 8);
      return allPos;
    }
    require totalMatches {
      let expected = derived.total;
      return after.total == expected && after.owner == before.owner;
    }
  }
`;

const COUNTER_POLICY = `
  transition nextStep {
    require increment {
      return before.count is int && before.count >= 0 && before.count <= 9007199254740991
        && after.count is int && after.count >= 0 && after.count <= 9007199254740991
        && after.count == before.count + 1;
    }
  }
`;

describe('Phase 3: Structured failure traces & placement/budget diagnostics', () => {
  test('judge() attaches JSON-serializable trace with let bindings, span, and failing sub-expression', () => {
    const policy = compilePolicy(ORDER_POLICY);
    const verdict = policy.judge({
      before: { owner: 'u1' },
      after: { total: 99, owner: 'u1' },
      input: { items: [{ price: 50 }, { price: 50 }] },
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected failure');
    expect(verdict.requirement).toBe('totalMatches');
    expect(verdict.reason).toBe('after.total was 99, expected 110');
    expect(verdict.trace).toBeDefined();
    const trace = verdict.trace!;
    expect(trace.requirement).toBe('totalMatches');
    expect(trace.outcome).toBe('false');
    expect(trace.fatal).toBe(false);
    expect(trace.span.line).toBeGreaterThan(1);
    expect(trace.span.location).toBe(verdict.location);
    expect(trace.bindings.map((b) => [b.scope, b.name, b.value])).toEqual([
      ['derive', 'itemTotal', 100],
      ['derive', 'tax', 10],
      ['require', 'expected', 110],
    ]);
    expect(trace.derived).toEqual({ subtotal: 100, total: 110 });
    expect(trace.failingSubExpression?.operator).toBe('==');
    expect(trace.failingSubExpression?.operands).toEqual([
      { source: 'after.total', value: 99 },
      { source: 'expected', value: 110 },
    ]);
    expect(trace.expressionUnitsUsed).toBeGreaterThan(0);
    expect(trace.expressionLimit).toBe(8192);

    // Strictly JSON-serializable round-trip
    const roundTripped = JSON.parse(JSON.stringify(verdict));
    expect(roundTripped.trace.failingSubExpression.operator).toBe('==');
  });

  test('judge() trace distinguishes eval-error vs fatal resource-limit and records captured error lets', () => {
    const policy = compilePolicy(ORDER_POLICY);

    // Missing field -> eval-error (not fatal)
    const missing = policy.judge({
      before: { owner: 'u1' },
      after: { owner: 'u1' },
      input: { items: [{ price: 20 }] },
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected failure');
    expect(missing.fatal).toBeUndefined();
    expect(missing.trace?.outcome).toBe('eval-error');
    expect(missing.trace?.fatal).toBe(false);
    expect(missing.trace?.failingSubExpression?.error).toContain('total');

    // Exceeding bounded limit -> resource-limit (fatal: true)
    const overLimit = policy.judge({
      before: { owner: 'u1' },
      after: { total: 9, owner: 'u1' },
      input: { items: Array.from({ length: 9 }, () => ({ price: 1 })) },
    });
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) throw new Error('expected failure');
    expect(overLimit.fatal).toBe(true);
    expect(overLimit.trace?.outcome).toBe('resource-limit');
    expect(overLimit.trace?.fatal).toBe(true);

    // Standalone ES module also emits JSON-serializable structured traces on false, eval-error, and fatal limit
    const mod = instantiateStandaloneModule(policy.standaloneModule().moduleSource);
    const standFail = mod.judge({
      before: { owner: 'u1' },
      after: { total: 99, owner: 'u1' },
      input: { items: [{ price: 50 }, { price: 50 }] },
    }) as { ok: boolean; trace?: { requirement: string; outcome: string; bindings: Array<{ name: string; value?: unknown }> } };
    expect(standFail.ok).toBe(false);
    expect(standFail.trace?.requirement).toBe('totalMatches');
    expect(standFail.trace?.outcome).toBe('false');
    expect(standFail.trace?.bindings.some((b) => b.name === 'expected' && b.value === 110)).toBe(true);
    expect(JSON.parse(JSON.stringify(standFail)).trace.requirement).toBe('totalMatches');

    const standMissing = mod.judge({
      before: { owner: 'u1' },
      after: { owner: 'u1' },
      input: { items: [{ price: 20 }] },
    }) as { ok: boolean; fatal?: boolean; trace?: { outcome: string; fatal: boolean } };
    expect(standMissing.ok).toBe(false);
    expect(standMissing.fatal).toBeUndefined();
    expect(standMissing.trace?.outcome).toBe('eval-error');
    expect(standMissing.trace?.fatal).toBe(false);

    const standOver = mod.judge({
      before: { owner: 'u1' },
      after: { total: 9, owner: 'u1' },
      input: { items: Array.from({ length: 9 }, () => ({ price: 1 })) },
    }) as { ok: boolean; fatal?: boolean; trace?: { outcome: string; fatal: boolean } };
    expect(standOver.ok).toBe(false);
    expect(standOver.fatal).toBe(true);
    expect(standOver.trace?.outcome).toBe('resource-limit');
    expect(standOver.trace?.fatal).toBe(true);
  });

  test('placement reports emit structured reason codes and expression-cost breakdowns', () => {
    const order = compilePolicy(ORDER_POLICY);
    const fsReport = order.firestore({}, 'mixed');
    expect(fsReport).toHaveLength(2);

    const posRow = fsReport[0]!;
    expect(posRow.enforcement).toBe('standalone only');
    expect(posRow.diagnostics.some((d) => d.code === 'USES_BOUNDED_OP')).toBe(true);
    expect(posRow.cost.boundedOps).toEqual([
      expect.objectContaining({ op: 'bounded.all', limit: 8 }),
    ]);
    expect(posRow.cost.sourceUnits).toBeGreaterThan(8);
    expect(posRow.cost.targetUnits).toBeNull();
    expect(posRow.span.line).toBeGreaterThan(1);

    const totRow = fsReport[1]!;
    expect(totRow.enforcement).toBe('standalone only');
    expect(totRow.diagnostics.some((d) => d.code === 'USES_DERIVE_COLLECTION' || d.code === 'USES_BOUNDED_OP' || d.code === 'USES_DERIVE')).toBe(true);

    const counter = compilePolicy(COUNTER_POLICY);
    const fsLowered = counter.firestore(
      { 'before.count': 'resource.data.count', 'after.count': 'request.resource.data.count' },
      'mixed',
    );
    expect(fsLowered[0]!.enforcement).toBe('standalone and database');
    expect(fsLowered[0]!.diagnostics).toEqual([expect.objectContaining({ code: 'LOWERED' })]);
    expect(fsLowered[0]!.cost.targetUnits).toBeGreaterThan(0);
    expect(fsLowered[0]!.cost.withinTargetBudget).toBe(true);

    const rtdbLowered = counter.rtdb({ 'before.count': 'data', 'after.count': 'newData' }, 'mixed');
    expect(rtdbLowered[0]!.enforcement).toBe('gateway and database');
    expect(rtdbLowered[0]!.diagnostics).toEqual([expect.objectContaining({ code: 'LOWERED' })]);

    const rtdbMissing = counter.rtdb({}, 'mixed');
    expect(rtdbMissing[0]!.enforcement).toBe('gateway only');
    expect(rtdbMissing[0]!.diagnostics.some((d) => d.code === 'MISSING_BINDING')).toBe(true);

    const unlowerableLoop = compileFunction(`
      use extension loops;
      function sumFour(xs) {
        let total = 0;
        for (const x of bounded(xs, 4)) { total = total + x; }
        return total;
      }
    `);
    const fnReport = unlowerableLoop.placement();
    expect(fnReport.firestoreLowerable).toBe(false);
    expect(fnReport.target).toBe('standalone');
    expect(fnReport.diagnostics[0]?.code).toBe('LOOP_NOT_LOWERABLE');
  });
});

describe('Phase 3: provePolicy() isomorphic verification API', () => {
  test('proves a lowerable transition across interpreter, standalone module, Firestore, and RTDB', () => {
    const report = provePolicy(COUNTER_POLICY, {
      firestore: {
        'before.count': 'resource.data.count',
        'after.count': 'request.resource.data.count',
      },
      rtdb: {
        'before.count': 'data',
        'after.count': 'newData',
      },
      scenarios: [
        { name: 'valid increment', transition: { before: { count: 4 }, after: { count: 5 }, input: {} }, expectOk: true },
        { name: 'skipped increment', transition: { before: { count: 4 }, after: { count: 6 }, input: {} }, expectOk: false, expectRequirement: 'increment' },
        { name: 'neg-zero rejected as float', transition: { before: { count: -0 }, after: { count: 1 }, input: {} }, expectOk: false },
      ],
      fuzz: { seed: 42, cases: 100, includeAdversarial: true },
    });

    expect(report.ok).toBe(true);
    expect(report.kind).toBe('transition');
    expect(report.staticCheck.ok).toBe(true);
    expect(report.staticCheck.acyclic).toBe(true);
    expect(report.standalone.ok).toBe(true);
    expect(report.placement.firestore?.[0]?.enforcement).toBe('standalone and database');
    expect(report.placement.rtdb?.[0]?.enforcement).toBe('gateway and database');
    expect(report.scenarios.passed).toBe(3);
    expect(report.scenarios.failed).toBe(0);
    expect(report.scenarios.results[0]?.firestore).toBe('ALLOW');
    expect(report.scenarios.results[0]?.rtdb).toBe('ALLOW');
    expect(report.scenarios.results[1]?.firestore).toBe('DENY');
    expect(report.scenarios.results[1]?.rtdb).toBe('DENY');
    expect(report.fuzz.casesRun).toBe(100);
    expect(report.fuzz.divergences).toEqual([]);

    // Entire proof report is strictly JSON-serializable
    const serialized = JSON.parse(JSON.stringify(report));
    expect(serialized.ok).toBe(true);
    expect(serialized.fuzz.casesRun).toBe(100);
  });

  test('proves a bounded module with seeded fuzzing and catches static check failures cleanly', () => {
    const modSrc = `
      use extension bounded;
      function clamp(x) { return x < 0 ? 0 : x > 10 ? 10 : x; }
      export function score(xs) {
        return bounded.fold(xs, 0, (acc, n) => acc + clamp(n), 8);
      }
    `;
    const okReport = provePolicy(modSrc, {
      scenarios: [
        { name: 'clamps values', args: [[-3, 5, 20]], expectValue: 15 },
        { name: 'bound exceeded', args: [[1, 1, 1, 1, 1, 1, 1, 1, 1]], expectError: true },
      ],
      fuzz: { seed: 99, cases: 80 },
    });
    expect(okReport.ok).toBe(true);
    expect(okReport.kind).toBe('module');
    expect(okReport.staticCheck.topoOrder).toEqual(['clamp', 'score']);
    expect(okReport.scenarios.passed).toBe(2);
    expect(okReport.fuzz.casesRun).toBe(80);
    expect(okReport.fuzz.divergences).toEqual([]);

    // Recursive module returns structured ok:false report instead of throwing
    const badReport = provePolicy(`
      use extension bounded;
      export function loop(n) { return loop(n - 1); }
    `);
    expect(badReport.ok).toBe(false);
    expect(badReport.staticCheck.ok).toBe(false);
    expect(badReport.staticCheck.error).toMatch(/Recursive/);
  });
});

describe('Phase 3: createPolicyGuard() Web-standard host boundary middleware', () => {
  test('guards Fetch/Next.js Route Handlers with Request/Response and SHA-256 digest header', async () => {
    const guard = createPolicyGuard(ORDER_POLICY, {
      includeTraceInResponse: true,
      attachDigestHeader: true,
      denyStatus: 403,
      fatalStatus: 422,
    });

    const route = guard.wrapFetch(jsonBodyExtractor(), async (_req, verified) => {
      return new Response(JSON.stringify({ ok: true, total: verified.derived?.total }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    // Allowed request
    const allowReq = new Request('https://app.example/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        before: { owner: 'u1' },
        after: { total: 110, owner: 'u1' },
        input: { items: [{ price: 50 }, { price: 50 }] },
      }),
    });
    const allowRes = await route(allowReq);
    expect(allowRes.status).toBe(201);
    expect(await allowRes.json()).toEqual({ ok: true, total: 110 });
    const digest = await guard.digest();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(allowRes.headers.get('x-policy-digest')).toBe(digest);

    // Denied request includes structured trace when opted in
    const denyReq = new Request('https://app.example/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        before: { owner: 'u1' },
        after: { total: 50, owner: 'u1' },
        input: { items: [{ price: 50 }, { price: 50 }] },
      }),
    });
    const denyRes = await route(denyReq);
    expect(denyRes.status).toBe(403);
    const denyBody = (await denyRes.json()) as { error: string; requirement: string; trace?: { bindings: unknown[] } };
    expect(denyBody.error).toBe('POLICY_DENIED');
    expect(denyBody.requirement).toBe('totalMatches');
    expect(denyBody.trace?.bindings.length).toBe(3);

    // Fatal resource limit uses fatalStatus (422)
    const fatalReq = new Request('https://app.example/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        before: { owner: 'u1' },
        after: { total: 9, owner: 'u1' },
        input: { items: Array.from({ length: 9 }, () => ({ price: 1 })) },
      }),
    });
    const fatalRes = await route(fatalReq);
    expect(fatalRes.status).toBe(422);
    const fatalBody = (await fatalRes.json()) as { error: string; fatal: boolean };
    expect(fatalBody.error).toBe('POLICY_LIMIT_EXCEEDED');
    expect(fatalBody.fatal).toBe(true);

    // Malformed JSON returns 400 Bad Request
    const badReq = new Request('https://app.example/api/checkout', { method: 'POST', body: '{bad json' });
    const badRes = await route(badReq);
    expect(badRes.status).toBe(400);
    expect(((await badRes.json()) as { error: string }).error).toBe('POLICY_BAD_REQUEST');
  });

  test('supports Cloud Functions (req, res) adapter and browser-like pure client optimistic checks', async () => {
    const guard = createPolicyGuard(ORDER_POLICY, { engine: 'standalone', includeTraceInResponse: false });

    // Client-side optimistic check + derive + assert (zero Node APIs)
    const valid = {
      before: { owner: 'u1' },
      after: { total: 55, owner: 'u1' },
      input: { items: [{ price: 50 }] },
    };
    expect(guard.derive({ before: valid.before, input: valid.input })).toEqual({ subtotal: 50, total: 55 });
    expect(guard.check(valid)).toEqual({ ok: true });
    expect(() => guard.assert(valid)).not.toThrow();

    const invalid = { ...valid, after: { total: 10, owner: 'u1' } };
    let caught: unknown;
    try {
      guard.assert(invalid);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PolicyDeniedError);
    expect((caught as PolicyDeniedError).requirement).toBe('totalMatches');

    // Cloud Functions / Express (req, res) wrapper
    let recordedStatus = 0;
    let recordedBody: unknown;
    const headers: Record<string, string> = {};
    const makeRes = (): HttpLikeResponse => ({
      status(code: number) {
        recordedStatus = code;
        return this;
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      json(body: unknown) {
        recordedBody = body;
      },
    });

    const fnHandler = guard.wrapHttpHandler(
      (req: HttpLikeRequest) => req.body as { before: unknown; after: unknown; input: unknown },
      (_req, res, verified) => {
        res.status(200).json!({ accepted: true, derived: verified.derived });
      },
    );

    await fnHandler({ method: 'POST', body: valid }, makeRes());
    expect(recordedStatus).toBe(200);
    expect(recordedBody).toEqual({ accepted: true, derived: { subtotal: 50, total: 55 } });

    await fnHandler({ method: 'POST', body: invalid }, makeRes());
    expect(recordedStatus).toBe(403);
    expect((recordedBody as { error: string; trace?: unknown }).error).toBe('POLICY_DENIED');
    // includeTraceInResponse: false ensures trace is omitted from external HTTP responses by default
    expect((recordedBody as { trace?: unknown }).trace).toBeUndefined();

    // Hostile getter/prototype payload rejected cleanly with 400 POLICY_BAD_REQUEST
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'owner', { enumerable: true, get() { throw new Error('getter trap'); } });
    await fnHandler(
      { method: 'POST', body: { before: hostile, after: { total: 55, owner: 'u1' }, input: { items: [{ price: 50 }] } } },
      makeRes(),
    );
    expect(recordedStatus).toBe(400);
    expect((recordedBody as { error: string }).error).toBe('POLICY_BAD_REQUEST');

    // jsonBodyExtractor enforces streaming maxBodyBytes (413), rejects __proto__ JSON keys (400), and never calls handler
    let handlerCalls = 0;
    const limitedRoute = guard.wrapFetch(
      jsonBodyExtractor({ includeQuery: true, maxBodyBytes: 128 }),
      async (_req, verified) => {
        handlerCalls++;
        const q = (verified.transition.input as Record<string, unknown>).query as Record<string, string>;
        return new Response(JSON.stringify({ mode: q.mode, hasProto: Object.hasOwn(q, '__proto__') }));
      },
    );
    const okQueryReq = new Request('https://app.example/api/checkout?mode=fast&__proto__=evil', {
      method: 'POST',
      body: JSON.stringify(valid),
    });
    const okQueryRes = await limitedRoute(okQueryReq);
    expect(okQueryRes.status).toBe(200);
    expect(await okQueryRes.json()).toEqual({ mode: 'fast', hasProto: false });
    expect(handlerCalls).toBe(1);

    // Chunked stream exceeding maxBodyBytes without Content-Length returns 413 before JSON.parse
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('{"before":{},"after":{},"pad":"'));
        controller.enqueue(enc.encode('x'.repeat(200)));
        controller.enqueue(enc.encode('"}'));
        controller.close();
      },
    });
    const bigStreamReq = new Request('https://app.example/api/checkout', {
      method: 'POST',
      body: stream,
    });
    const bigRes = await limitedRoute(bigStreamReq);
    expect(bigRes.status).toBe(413);
    expect(((await bigRes.json()) as { error: string }).error).toBe('POLICY_PAYLOAD_TOO_LARGE');

    // JSON body containing own "__proto__" key fails closed with 400
    const protoReq = new Request('https://app.example/api/checkout', {
      method: 'POST',
      body: '{"before":{"__proto__":{"admin":true}},"after":{"total":55},"input":{}}',
    });
    const protoRes = await limitedRoute(protoReq);
    expect(protoRes.status).toBe(400);
    expect(((await protoRes.json()) as { error: string }).error).toBe('POLICY_BAD_REQUEST');

    // Downstream handler was never invoked on any rejected request
    expect(handlerCalls).toBe(1);

    // Exponential DAG inside a let binding stays bounded in verdict.trace and JSON.stringify
    const dagPolicy = compilePolicy(`
      transition dagTrace {
        require failWithDag {
          let a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
          let b = [a, a, a, a, a, a, a, a, a, a];
          let c = [b, b, b, b, b, b, b, b, b, b];
          let d = [c, c, c, c, c, c, c, c, c, c];
          return after.x == 1 && d is list;
        }
      }
    `);
    const t0 = performance.now();
    const dagVerdict = dagPolicy.judge({ before: {}, after: { x: 2 }, input: {} });
    const dagStand = instantiateStandaloneModule(dagPolicy.standaloneModule().moduleSource).judge({
      before: {},
      after: { x: 2 },
      input: {},
    });
    const serializedDag = JSON.stringify({ dagVerdict, dagStand });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(serializedDag).toContain('max-nodes');
  });

  test('pins audit regressions for provePolicy boundaries/auth/kind, guard.derive fidelity, HTTP 413, and standalone trace budget', async () => {
    // 1. provePolicy catches hostile / over-bound transition scenarios without throwing uncaught
    const getterObj: Record<string, unknown> = {};
    Object.defineProperty(getterObj, 's', { enumerable: true, get() { return 'hi'; } });
    const hostileReport = provePolicy(`transition t { require ok { return after.s == 'hi'; } }`, {
      scenarios: [
        { name: 'over-long string', transition: { before: {}, after: { s: 'a'.repeat(5000) }, input: {} }, expectError: true },
        { name: 'hostile getter', transition: { before: {}, after: getterObj, input: {} }, expectError: true },
        { name: 'non-plain proto', transition: { before: {}, after: Object.create({ s: 'hi' }), input: {} }, expectOk: false },
      ],
      fuzz: { enabled: false },
    });
    expect(hostileReport.ok).toBe(true);
    expect(hostileReport.scenarios.passed).toBe(3);

    // 2. provePolicy populates request.auth.* and projects renamed/nested Firestore fields accurately
    const ownerPolicy = `
      transition ownerEdit {
        require isOwner {
          return before.owner == input.uid && after.count == before.count + 1;
        }
      }
    `;
    const authReport = provePolicy(ownerPolicy, {
      firestore: {
        'before.owner': 'resource.data.ownerId',
        'before.count': 'resource.data.meta.count',
        'after.count': 'request.resource.data.meta.count',
        'input.uid': 'request.auth.uid',
      },
      scenarios: [
        { name: 'owner allowed', transition: { before: { owner: 'alice', count: 1 }, after: { count: 2 }, input: { uid: 'alice' } }, expectOk: true },
        { name: 'non-owner denied', transition: { before: { owner: 'alice', count: 1 }, after: { count: 2 }, input: { uid: 'bob' } }, expectOk: false },
        { name: 'null uid outside auth.uid domain', transition: { before: { owner: null, count: 1 }, after: { count: 2 }, input: { uid: null } }, expectOk: true },
      ],
      fuzz: { seed: 7, cases: 60 },
    });
    expect(authReport.ok).toBe(true);
    expect(authReport.scenarios.results[0]?.firestore).toBe('ALLOW');
    expect(authReport.scenarios.results[1]?.firestore).toBe('DENY');
    expect(authReport.scenarios.results[2]?.firestore).toBeUndefined();

    // 3. guard.derive() preserves full strings (>512), arrays (>64), and -0 without diagnostic truncation
    const richPolicy = `
      use extension derive;
      transition rich {
        derive { return {'text': input.text, 'negZero': -0.0, 'items': input.items}; }
        require ok { return after.ok == true; }
      }
    `;
    const richInterp = createPolicyGuard(richPolicy, { engine: 'interpreter' });
    const richStand = createPolicyGuard(richPolicy, { engine: 'standalone' });
    const bigInput = { text: 'x'.repeat(600), items: Array.from({ length: 70 }, (_, i) => i) };
    for (const g of [richInterp, richStand]) {
      const out = g.derive({ before: {}, input: bigInput }) as { text: string; negZero: number; items: number[] };
      expect(out.text.length).toBe(600);
      expect(Object.is(out.negZero, -0)).toBe(true);
      expect(out.items.length).toBe(70);
    }

    // 4. wrapHttpHandler maps PolicyPayloadTooLargeError to 413 POLICY_PAYLOAD_TOO_LARGE
    let status413 = 0;
    let body413: unknown;
    const h413 = richStand.wrapHttpHandler(
      () => { throw new PolicyPayloadTooLargeError(1024); },
      (_req, res) => { res.status(200).json!({ ok: true }); },
    );
    await h413(
      { method: 'POST' },
      { status(c: number) { status413 = c; return this; }, json(b: unknown) { body413 = b; } },
    );
    expect(status413).toBe(413);
    expect((body413 as { error: string }).error).toBe('POLICY_PAYLOAD_TOO_LARGE');

    // 5. standaloneModule().judge().trace populates expressionUnitsUsed and expressionLimit
    const standDeny = richStand.check({ before: {}, after: { ok: false }, input: { text: 'a', items: [] } });
    expect(standDeny.ok).toBe(false);
    if (!standDeny.ok) {
      expect(standDeny.trace?.expressionUnitsUsed).toBeGreaterThan(0);
      expect(standDeny.trace?.expressionLimit).toBe(8192);
    }

    // 6. detectPolicyKind ignores 'transition foo {' inside strings and comments
    expect(detectPolicyKind('function check(s) { return s == "a transition fake {"; }')).toBe('function');
    expect(detectPolicyKind('// transition fake {\nfunction check(x) { return x > 0; }')).toBe('function');
    const fnStrReport = provePolicy('function check(s) { return s == "a transition fake {"; }', {
      scenarios: [{ name: 'matches literal', args: ['a transition fake {'], expectValue: true }],
      fuzz: { enabled: false },
    });
    expect(fnStrReport.ok).toBe(true);
    expect(fnStrReport.kind).toBe('function');
  });
});
