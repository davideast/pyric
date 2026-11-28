// Phase 2+3 fusion and split-enforcement composition verification tests.
// Covers policy.storage() diagnostics, provePolicy() with Storage & unified RTDB,
// databasePredicate && gatewayResidual === fullStandalone across all 4 path classes,
// and createPolicyGuard() target & residual-mode integration.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compilePolicy,
  createPolicyGuard,
  jsonBodyExtractor,
  PolicyDeniedError,
  provePolicy,
  verifySplitEnforcement,
  type HttpLikeRequest,
  type HttpLikeResponse,
  type Transition,
  type Verdict,
} from '../../src/policy/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'pyric-split-fusion-'));
let seq = 0;
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

async function importTempModule(moduleSource: string, tag: string) {
  const file = join(tempDir, `${tag}-${seq++}.mjs`);
  writeFileSync(file, moduleSource, 'utf8');
  return (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>;
}

const VOICE_UPLOAD_POLICY = `
  use extension methods;
  transition voiceUpload {
    require validClip {
      return input.auth != null
        && after.size > 0
        && after.size <= 1048576
        && after.contentType.matches('^audio/(wav|ogg)$')
        && after.metadata.get('owner', '') == input.auth.uid;
    }
  }
`;

const SPLIT_FIRESTORE_POLICY = `
  use extension bounded;
  transition orderUpdate {
    require boundedItems {
      let ok = bounded.all(input.items, item => item > 0, 3);
      return ok;
    }
    require ownerStep {
      return before.owner == input.uid
        && after.owner == before.owner
        && after.version == before.version + 1;
    }
  }
`;

const SPLIT_FIRESTORE_DB_FIRST = `
  use extension bounded;
  transition orderUpdateDbFirst {
    require ownerStep {
      return before.owner == input.uid && after.version == before.version + 1;
    }
    require boundedItems {
      return bounded.all(input.items, item => item > 0, 2);
    }
  }
`;

const SPLIT_RTDB_POLICY = `
  use extension bounded;
  use extension methods;
  transition rtdbGameMove {
    require validMoveList {
      return bounded.all(input.moves, m => m >= 0, 3);
    }
    require scoreStep {
      return before.score is int && after.score is int
        && after.score == before.score + 1
        && after.tag is string && after.tag.size() >= 2;
    }
  }
`;

const SPLIT_STORAGE_POLICY = `
  use extension bounded;
  use extension methods;
  transition mediaUpload {
    require tagsValid {
      return bounded.all(input.tags, t => t is string && t.size() > 0, 3);
    }
    require objectCheck {
      return input.auth != null
        && after.size > 0
        && after.size <= 4096
        && after.contentType.matches('^image/(png|jpeg)$');
    }
  }
`;

describe('Phase 2+3 Fusion: policy.storage() diagnostics and provePolicy() targets', () => {
  test('policy.storage() emits span, structured diagnostics, cost breakdown, and completeReason', () => {
    const okRows = compilePolicy(VOICE_UPLOAD_POLICY).storage(
      { 'input.auth': 'request.auth', after: 'request.resource' },
      'mixed',
    );
    expect(okRows).toHaveLength(1);
    const row = okRows[0]!;
    expect(row.enforcement).toBe('standalone and storage');
    expect(row.span.line).toBeGreaterThan(1);
    expect(row.diagnostics).toEqual([expect.objectContaining({ code: 'LOWERED' })]);
    expect(row.cost.targetUnits).toBeGreaterThan(0);
    expect(row.cost.withinTargetBudget).toBe(true);
    expect(row.cost.targetChars).toBe(row.predicate!.length);
    expect(row.bindings['after.size']).toBe('request.resource');

    const badProj = compilePolicy(VOICE_UPLOAD_POLICY).storage(
      { 'input.auth': 'request.auth', after: 'request.resource.data' },
      'mixed',
    );
    expect(badProj[0]!.enforcement).toBe('standalone only');
    expect(badProj[0]!.diagnostics.some((d) => d.code === 'INVALID_BINDING_PROJECTION')).toBe(true);
    expect(badProj[0]!.cost.fallbackSummary).toContain('Fallback (standalone only)');

    const missing = compilePolicy(VOICE_UPLOAD_POLICY).storage({}, 'mixed');
    expect(missing[0]!.diagnostics.some((d) => d.code === 'MISSING_BINDING')).toBe(true);

    const wrongOrigin = compilePolicy('transition t { require r { return after.size < 10; } }').storage(
      { 'after.size': 'resource.size' },
      'mixed',
    );
    expect(wrongOrigin[0]!.diagnostics.some((d) => d.code === 'WRONG_SNAPSHOT_ORIGIN')).toBe(true);

    const siblingDerive = compilePolicy(`
      use extension derive;
      transition t {
        derive { return {'maxSize': before.size + 10, 'other': before.size * 2}; }
        require r { return after.size <= derived.maxSize; }
      }
    `).storage({ before: 'resource', after: 'request.resource' }, 'mixed');
    expect(siblingDerive[0]!.completeReason).toBe('Unverified derive outputs: other');
    expect(siblingDerive[0]!.diagnostics.some((d) => d.code === 'UNVERIFIED_DERIVE_SIBLINGS')).toBe(true);
  });

  test('provePolicy() proves Storage create, update, and delete policies with active fuzz coverage', () => {
    const createReport = provePolicy(VOICE_UPLOAD_POLICY, {
      storage: { 'input.auth': 'request.auth', after: 'request.resource' },
      scenarios: [
        {
          name: 'valid wav',
          transition: { before: {}, after: { size: 512, contentType: 'audio/wav', metadata: { owner: 'alice' } }, input: { auth: { uid: 'alice' } } },
          expectOk: true,
        },
        {
          name: 'wrong owner',
          transition: { before: {}, after: { size: 512, contentType: 'audio/wav', metadata: { owner: 'bob' } }, input: { auth: { uid: 'alice' } } },
          expectOk: false,
        },
        {
          name: 'anon rejected',
          transition: { before: {}, after: { size: 512, contentType: 'audio/wav', metadata: { owner: 'alice' } }, input: { auth: null } },
          expectOk: false,
        },
      ],
      fuzz: { seed: 101, cases: 40, includeAdversarial: true },
    });
    expect(createReport.ok).toBe(true);
    expect(createReport.placement.storage?.[0]?.enforcement).toBe('standalone and storage');
    expect(createReport.scenarios.results.map((r) => r.storage)).toEqual(['ALLOW', 'DENY', 'DENY']);
    expect(createReport.split?.storage?.plan.mode).toBe('complete');
    expect(createReport.split?.storage?.plan.storageMethod).toBe('create');
    expect(createReport.split?.storage?.checked).toBeGreaterThan(20);
    expect(createReport.split?.storage?.pathCounts.allow).toBeGreaterThan(0);
    expect(createReport.split?.storage?.pathCounts.deny).toBeGreaterThan(0);

    const updatePolicy = `
      transition keepOwner {
        require sameOwner {
          return input.uid == before.metadata.owner
            && after.metadata.owner == before.metadata.owner
            && after.size <= before.size;
        }
      }
    `;
    const updReport = provePolicy(updatePolicy, {
      storage: { 'input.uid': 'request.auth.uid', before: 'resource', after: 'request.resource' },
      scenarios: [
        {
          name: 'shrink ok',
          transition: {
            before: { size: 1000, metadata: { owner: 'alice' } },
            after: { size: 500, metadata: { owner: 'alice' } },
            input: { uid: 'alice' },
          },
          expectOk: true,
        },
        {
          name: 'transfer denied',
          transition: {
            before: { size: 1000, metadata: { owner: 'alice' } },
            after: { size: 500, metadata: { owner: 'bob' } },
            input: { uid: 'alice' },
          },
          expectOk: false,
        },
      ],
      fuzz: { seed: 7, cases: 25 },
    });
    expect(updReport.ok).toBe(true);
    expect(updReport.split?.storage?.plan.storageMethod).toBe('update');
    expect(updReport.scenarios.results.map((r) => r.storage)).toEqual(['ALLOW', 'DENY']);

    // Delete verb with path wildcard identifier binding
    const delPolicy = `
      transition deleteOwn {
        require ownerMatch { return input.uid == input.owner && before.size <= 1024; }
      }
    `;
    const delReport = provePolicy(delPolicy, {
      storage: { 'input.uid': 'request.auth.uid', 'input.owner': 'uid', before: 'resource' },
      storageMethod: 'delete',
      scenarios: [
        { name: 'own small file', transition: { before: { size: 100 }, after: {}, input: { uid: 'alice', owner: 'alice' } }, expectOk: true },
        { name: 'foreign file', transition: { before: { size: 100 }, after: {}, input: { uid: 'bob', owner: 'alice' } }, expectOk: false },
      ],
      fuzz: { seed: 9, cases: 20 },
    });
    expect(delReport.ok).toBe(true);
    expect(delReport.split?.storage?.plan.storageMethod).toBe('delete');
    expect(delReport.scenarios.results.map((r) => r.storage)).toEqual(['ALLOW', 'DENY']);
  });

  test('provePolicy() supports unified RTDB bindings (root map, nested path, typed, after-only, parent)', () => {
    const rootPolicy = `
      use extension methods;
      transition stateStep {
        require step {
          return after.x == before.x + 1 && after.name is string && after.name.size() >= 2;
        }
      }
    `;
    const rootReport = provePolicy(rootPolicy, {
      rtdb: { before: 'data', after: 'newData' },
      scenarios: [
        { name: 'ok', transition: { before: { x: 1 }, after: { x: 2, name: 'hi' }, input: {} }, expectOk: true },
        { name: 'short name', transition: { before: { x: 1 }, after: { x: 2, name: 'a' }, input: {} }, expectOk: false },
        { name: 'missing before.x', transition: { before: {}, after: { x: 2, name: 'hi' }, input: {} }, expectOk: false },
      ],
      fuzz: { seed: 33, cases: 40, includeAdversarial: true },
    });
    expect(rootReport.ok).toBe(true);
    expect(rootReport.scenarios.results.map((r) => r.rtdb)).toEqual(['ALLOW', 'DENY', 'DENY']);
    expect(rootReport.split?.rtdb?.checked).toBeGreaterThan(5);

    // Structured path + parent: true binding
    const parentPolicy = `
      transition guardedWrite {
        require underCap { return after.v > 0 && after.v <= before.cap; }
      }
    `;
    const parentReport = provePolicy(parentPolicy, {
      rtdb: {
        'before.cap': { snapshot: 'data', parent: true, path: 'limits/max', type: 'number' },
        'after.v': { snapshot: 'newData', path: 'value', type: 'number' },
      },
      scenarios: [
        { name: 'within cap', transition: { before: { cap: 10 }, after: { v: 7 }, input: {} }, expectOk: true },
        { name: 'over cap', transition: { before: { cap: 10 }, after: { v: 12 }, input: {} }, expectOk: false },
      ],
      fuzz: { seed: 12, cases: 25 },
    });
    expect(parentReport.ok).toBe(true);
    expect(parentReport.scenarios.results.map((r) => r.rtdb)).toEqual(['ALLOW', 'DENY']);

    // Single-sided after-only binding
    const afterOnly = provePolicy('transition t { require pos { return after.n is int && after.n > 0; } }', {
      rtdb: { after: { snapshot: 'newData' } },
      scenarios: [
        { name: 'pos', transition: { before: {}, after: { n: 5 }, input: {} }, expectOk: true },
        { name: 'zero', transition: { before: {}, after: { n: 0 }, input: {} }, expectOk: false },
      ],
      fuzz: { enabled: false },
    });
    expect(afterOnly.ok).toBe(true);
    expect(afterOnly.scenarios.results.map((r) => r.rtdb)).toEqual(['ALLOW', 'DENY']);
  });
});

describe('Split-enforcement composition proofs (dbPredicate && gatewayResidual === fullStandalone)', () => {
  test('verifies Firestore split composition across allow, deny, recoverable error, fatal budget, and both orderings', () => {
    const fsBindings = {
      'before.owner': 'resource.data.owner',
      'before.version': 'resource.data.version',
      'after.owner': 'request.resource.data.owner',
      'after.version': 'request.resource.data.version',
      'input.uid': 'request.auth.uid',
    };
    const getterObj: Record<string, unknown> = {};
    Object.defineProperty(getterObj, 'owner', { enumerable: true, get() { throw new Error('trap'); } });

    const res = verifySplitEnforcement(SPLIT_FIRESTORE_POLICY, {
      firestore: fsBindings,
      scenarios: [
        {
          name: 'allow',
          transition: { before: { owner: 'a', version: 1 }, after: { owner: 'a', version: 2 }, input: { uid: 'a', items: [1, 2] } },
          expectOk: true,
        },
        {
          name: 'db deny false',
          transition: { before: { owner: 'a', version: 1 }, after: { owner: 'a', version: 9 }, input: { uid: 'a', items: [1, 2] } },
          expectOk: false,
          expectRequirement: 'ownerStep',
        },
        {
          name: 'residual deny false',
          transition: { before: { owner: 'a', version: 1 }, after: { owner: 'a', version: 2 }, input: { uid: 'a', items: [1, -3] } },
          expectOk: false,
          expectRequirement: 'boundedItems',
        },
        {
          name: 'recoverable eval-error (missing version)',
          transition: { before: { owner: 'a' }, after: { owner: 'a', version: 2 }, input: { uid: 'a', items: [1] } },
          expectOk: false,
        },
        {
          name: 'recoverable eval-error (non-list items)',
          transition: { before: { owner: 'a', version: 1 }, after: { owner: 'a', version: 2 }, input: { uid: 'a', items: 'bad' } },
          expectOk: false,
        },
        {
          name: 'fatal budget with DB allow',
          transition: { before: { owner: 'a', version: 1 }, after: { owner: 'a', version: 2 }, input: { uid: 'a', items: [1, 2, 3, 4] } },
          expectOk: false,
          expectRequirement: 'boundedItems',
        },
        {
          name: 'fatal budget BEFORE DB deny is NEVER swallowed',
          transition: { before: { owner: 'a', version: 1 }, after: { owner: 'evil', version: 99 }, input: { uid: 'a', items: [1, 2, 3, 4] } },
          expectOk: false,
          expectRequirement: 'boundedItems',
        },
        {
          name: 'hostile getter boundary matches',
          transition: { before: getterObj, after: { owner: 'a', version: 2 }, input: { uid: 'a', items: [1] } },
          expectError: true,
        },
      ],
      fuzz: { seed: 2026, cases: 50, includeAdversarial: true },
    });

    expect(res.ok).toBe(true);
    const fs = res.targets.firestore!;
    expect(fs.plan.mode).toBe('split');
    expect(fs.plan.databaseRequirements).toEqual(['ownerStep']);
    expect(fs.plan.residualRequirements).toEqual(['boundedItems']);
    expect(fs.pathCounts.allow).toBeGreaterThan(0);
    expect(fs.pathCounts.deny).toBeGreaterThan(0);
    expect(fs.pathCounts.recoverableError).toBeGreaterThan(0);
    expect(fs.pathCounts.fatalBudget).toBeGreaterThanOrEqual(2);
    expect(fs.divergences).toEqual([]);

    // Residual fatal before DB deny: dbDecision is DENY, yet composed.fatal stays true
    const fatalAndDeny = res.scenarios.results[6]!.split!.firestore!;
    expect(fatalAndDeny.dbDecision).toBe('DENY');
    expect(fatalAndDeny.composed).toEqual({ decision: 'DENY', fatal: true });
    expect(fatalAndDeny.parityOk).toBe(true);

    // Opposite ordering: DB deny BEFORE residual fatal is tracked via fatalOrderDifferences
    const dbFirst = verifySplitEnforcement(SPLIT_FIRESTORE_DB_FIRST, {
      firestore: {
        'before.owner': 'resource.data.owner',
        'before.version': 'resource.data.version',
        'after.version': 'request.resource.data.version',
        'input.uid': 'request.auth.uid',
      },
      scenarios: [
        {
          name: 'db denies before residual fatal',
          transition: { before: { owner: 'a', version: 1 }, after: { version: 99 }, input: { uid: 'a', items: [1, 2, 3] } },
          expectOk: false,
          expectRequirement: 'ownerStep',
        },
      ],
      fuzz: { enabled: false },
    });
    expect(dbFirst.ok).toBe(true);
    expect(dbFirst.targets.firestore?.fatalOrderDifferences).toBe(1);
    expect(dbFirst.scenarios.results[0]?.split?.firestore?.dbDeniedBeforeResidualFatal).toBe(true);

    // JSON-serializable round-trip
    expect(JSON.parse(JSON.stringify(res)).ok).toBe(true);
  });

  test('verifies RTDB and Storage split composition across allow, deny, recoverable error, and fatal budget', () => {
    const rtdbRes = verifySplitEnforcement(SPLIT_RTDB_POLICY, {
      rtdb: { before: 'data', after: 'newData' },
      scenarios: [
        { name: 'allow', transition: { before: { score: 1 }, after: { score: 2, tag: 'ok' }, input: { moves: [0, 1] } }, expectOk: true },
        { name: 'db deny', transition: { before: { score: 1 }, after: { score: 5, tag: 'ok' }, input: { moves: [0] } }, expectOk: false },
        { name: 'eval error', transition: { before: {}, after: { score: 2, tag: 'ok' }, input: { moves: [0] } }, expectOk: false },
        { name: 'fatal + db deny', transition: { before: { score: 1 }, after: { score: 9, tag: 'x' }, input: { moves: [1, 2, 3, 4] } }, expectOk: false },
      ],
      fuzz: { seed: 55, cases: 30, includeAdversarial: true },
    });
    expect(rtdbRes.ok).toBe(true);
    expect(rtdbRes.targets.rtdb?.plan.mode).toBe('split');
    expect(rtdbRes.targets.rtdb?.plan.databaseRequirements).toEqual(['scoreStep']);
    expect(rtdbRes.targets.rtdb?.plan.residualRequirements).toEqual(['validMoveList']);
    expect(rtdbRes.targets.rtdb?.pathCounts.allow).toBeGreaterThan(0);
    expect(rtdbRes.targets.rtdb?.pathCounts.deny).toBeGreaterThan(0);
    expect(rtdbRes.targets.rtdb?.pathCounts.recoverableError).toBeGreaterThan(0);
    expect(rtdbRes.targets.rtdb?.pathCounts.fatalBudget).toBeGreaterThan(0);
    expect(rtdbRes.scenarios.results[3]?.split?.rtdb?.composed).toEqual({ decision: 'DENY', fatal: true });

    const storageRes = verifySplitEnforcement(SPLIT_STORAGE_POLICY, {
      storage: { 'input.auth': 'request.auth', after: 'request.resource' },
      scenarios: [
        { name: 'allow', transition: { before: {}, after: { size: 512, contentType: 'image/png' }, input: { auth: { uid: 'u1' }, tags: ['cat'] } }, expectOk: true },
        { name: 'db deny mime', transition: { before: {}, after: { size: 512, contentType: 'text/plain' }, input: { auth: { uid: 'u1' }, tags: ['cat'] } }, expectOk: false },
        { name: 'eval error residual', transition: { before: {}, after: { size: 512, contentType: 'image/png' }, input: { auth: { uid: 'u1' }, tags: 42 } }, expectOk: false },
        { name: 'fatal + db deny', transition: { before: {}, after: { size: 99999, contentType: 'text/plain' }, input: { auth: { uid: 'u1' }, tags: ['a', 'b', 'c', 'd'] } }, expectOk: false },
      ],
      fuzz: { seed: 77, cases: 30, includeAdversarial: true },
    });
    expect(storageRes.ok).toBe(true);
    expect(storageRes.targets.storage?.plan.mode).toBe('split');
    expect(storageRes.targets.storage?.plan.databaseRequirements).toEqual(['objectCheck']);
    expect(storageRes.targets.storage?.plan.residualRequirements).toEqual(['tagsValid']);
    expect(storageRes.targets.storage?.pathCounts.allow).toBeGreaterThan(0);
    expect(storageRes.targets.storage?.pathCounts.deny).toBeGreaterThan(0);
    expect(storageRes.targets.storage?.pathCounts.recoverableError).toBeGreaterThan(0);
    expect(storageRes.targets.storage?.pathCounts.fatalBudget).toBeGreaterThan(0);
    expect(storageRes.scenarios.results[3]?.split?.storage?.composed).toEqual({ decision: 'DENY', fatal: true });
  });

  test('detects fatal expressionLimit loss on a lowered requirement and keeps incomplete derive in residual', () => {
    const tight = verifySplitEnforcement(
      'transition t { require big { return after.x == before.x + 1 + 1 + 1 + 1 + 1 + 1; } }',
      {
        expressionLimit: 4,
        firestore: { 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' },
        scenarios: [{ name: 'hits tight host limit', transition: { before: { x: 0 }, after: { x: 6 }, input: {} } }],
        fuzz: { enabled: false },
      },
    );
    expect(tight.ok).toBe(false);
    expect(tight.targets.firestore?.divergences[0]?.outcome.mismatch).toContain('Fatal budget limit');

    // Derive with unverified sibling stays in residual so sibling error is never bypassed
    const incompleteDerive = `
      use extension derive;
      transition t {
        derive { return {'a': before.x + 1, 'b': before.missing + 1}; }
        require checkA { return after.a == derived.a; }
      }
    `;
    const check = verifySplitEnforcement(incompleteDerive, {
      firestore: { 'before.x': 'resource.data.x', 'after.a': 'request.resource.data.a' },
      rtdb: { before: 'data', after: 'newData' },
      scenarios: [
        { name: 'sibling error denies', transition: { before: { x: 1 }, after: { a: 2 }, input: {} }, expectOk: false },
        { name: 'both present allows', transition: { before: { x: 1, missing: 5 }, after: { a: 2 }, input: {} }, expectOk: true },
      ],
      fuzz: { enabled: false },
    });
    expect(check.ok).toBe(true);
    expect(check.targets.firestore?.plan.mode).toBe('gateway-only');
    expect(check.targets.rtdb?.plan.mode).toBe('gateway-only');
    expect(check.targets.firestore?.plan.residualRequirements).toEqual(['checkA']);
    expect(check.targets.rtdb?.plan.residualRequirements).toEqual(['checkA']);
  });
});

describe('Phase 2+3 Fusion: createPolicyGuard() with Firestore, unified RTDB, Storage, and residual mode', () => {
  test('exposes multi-target placement, storage/rtdb/firestore views, modules, and verifySplit()', async () => {
    const guard = createPolicyGuard(SPLIT_STORAGE_POLICY, {
      storage: { 'input.auth': 'request.auth', after: 'request.resource' },
      firestore: {
        'input.auth': 'request.auth',
        'after.size': 'request.resource.data.size',
        'after.contentType': 'request.resource.data.contentType',
      },
      rtdb: { after: 'newData' },
    });
    expect(guard.enforcement).toBe('full');
    const pl = guard.placement();
    expect(pl.storage?.plan.mode).toBe('split');
    expect(pl.storage?.plan.databaseRequirements).toEqual(['objectCheck']);
    expect(pl.storage?.plan.residualRequirements).toEqual(['tagsValid']);
    expect(pl.rtdb?.plan.mode).toBe('gateway-only');
    expect(guard.storage().length).toBe(2);
    expect(guard.rtdb().length).toBe(2);
    expect(guard.firestore().length).toBe(2);
    expect(JSON.parse(JSON.stringify(pl)).storage.plan.mode).toBe('split');

    // Load emitted residual ES module from a temp .mjs file URL (never data: URI)
    const resMod = await importTempModule(guard.residualModule('storage').moduleSource, 'storage-residual');
    const judge = resMod.judge as (t: Transition) => Verdict;
    // Residual ignores DB-enforced size/mime, enforces tagsValid including fatal bound
    expect(judge({ before: {}, after: { size: 999999, contentType: 'text/plain' }, input: { auth: null, tags: ['ok'] } })).toEqual({ ok: true });
    const fatal = judge({ before: {}, after: { size: 100, contentType: 'image/png' }, input: { auth: { uid: 'u1' }, tags: ['a', 'b', 'c', 'd'] } });
    expect(fatal.ok).toBe(false);
    if (!fatal.ok) expect(fatal.fatal).toBe(true);

    const splitOk = guard.verifySplit(
      { before: {}, after: { size: 100, contentType: 'image/png' }, input: { auth: { uid: 'u1' }, tags: ['ok'] } },
      'storage',
    );
    expect(splitOk.parityOk).toBe(true);
    expect(splitOk.composed).toEqual({ decision: 'ALLOW', fatal: false });

    // storageModule() works on a fully lowerable Storage guard
    const fullStorageGuard = createPolicyGuard(VOICE_UPLOAD_POLICY, {
      storage: { 'input.auth': 'request.auth', after: 'request.resource' },
    });
    expect(fullStorageGuard.storageModule()).toContain('export function voiceUpload()');
  });

  test('supports residual enforcement in interpreter & standalone engines, Fetch, HTTP, and fails closed on misconfig', async () => {
    for (const engine of ['interpreter', 'standalone'] as const) {
      const guard = createPolicyGuard(SPLIT_STORAGE_POLICY, {
        engine,
        enforcement: 'residual',
        storage: { 'input.auth': 'request.auth', after: 'request.resource' },
        denyStatus: 403,
        fatalStatus: 422,
      });
      expect(guard.enforcement).toBe('residual');
      expect(guard.residualTarget).toBe('storage');

      // Only residual (`tagsValid`) runs on gateway; DB-only rule is delegated to Storage
      const onlyDbBad = { before: {}, after: { size: 99999, contentType: 'text/plain' }, input: { auth: null, tags: ['ok'] } };
      expect(guard.check(onlyDbBad)).toEqual({ ok: true });

      const badTag = { before: {}, after: { size: 100, contentType: 'image/png' }, input: { auth: { uid: 'u1' }, tags: [''] } };
      expect(() => guard.assert(badTag)).toThrow(PolicyDeniedError);

      const route = guard.wrapFetch(jsonBodyExtractor(), () => new Response('ok', { status: 200 }));
      const fatalRes = await route(
        new Request('https://app.example/upload', {
          method: 'POST',
          body: JSON.stringify({ before: {}, after: { size: 100, contentType: 'image/png' }, input: { auth: { uid: 'u1' }, tags: ['1', '2', '3', '4'] } }),
        }),
      );
      expect(fatalRes.status).toBe(422);

      let httpStatus = 0;
      const resObj: HttpLikeResponse = { status(c) { httpStatus = c; return this; }, json() {} };
      const handler = guard.wrapHttpHandler((req: HttpLikeRequest) => req.body as Transition, (_q, r) => r.status(200).json!({}));
      await handler({ method: 'POST', body: badTag }, resObj);
      expect(httpStatus).toBe(403);
    }

    // Complete target residual guard still rejects hostile getters / prototype traps
    const completeGuard = createPolicyGuard(VOICE_UPLOAD_POLICY, {
      engine: 'standalone',
      enforcement: 'residual',
      storage: { 'input.auth': 'request.auth', after: 'request.resource' },
    });
    const trap: Record<string, unknown> = {};
    Object.defineProperty(trap, 'size', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => completeGuard.check({ before: {}, after: trap, input: {} })).toThrow(/Missing own data value/);

    // Misconfigured residual mode throws explicitly instead of silently skipping rules
    expect(() => createPolicyGuard(SPLIT_STORAGE_POLICY, { enforcement: 'residual' })).toThrow(/No target bindings/);
    expect(() =>
      createPolicyGuard(SPLIT_STORAGE_POLICY, {
        enforcement: 'residual',
        storage: { 'input.auth': 'request.auth', after: 'request.resource' },
        rtdb: { after: 'newData' },
      }),
    ).toThrow(/specify residualTarget/);
  });

  test('all files under src/policy/ stay free of Node-only imports', () => {
    const dir = join(import.meta.dir, '../../src/policy');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const content = readFileSync(join(dir, file), 'utf8');
      expect(content, file).not.toMatch(/from\s+['"]node:/);
    }
  });
});
