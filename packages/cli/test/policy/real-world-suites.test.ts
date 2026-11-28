import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firestoreRules, rtdbRules, storageRules } from '../../../rules/dist/index.js';
import { compilePolicy, provePolicy, type Verdict } from '../../../rules/dist/policy/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const ORACLE_ROOT = join(REPO_ROOT, 'experiments/policy-oracle');
const REAL_WORLD_ROOT = join(ORACLE_ROOT, 'suites/real-world');

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Bun 1.3.11+ and Node 22/24 safe dynamic loader (no data: URIs).
async function importStandaloneModule(
  moduleSource: string,
  label: string,
): Promise<{ judge: (t: { before: unknown; after: unknown; input: unknown }) => Verdict; derive?: (s: { before: unknown; input: unknown }) => unknown }> {
  const dir = mkdtempSync(join(tmpdir(), `pyric-rw-${label}-`));
  tempDirs.push(dir);
  const filePath = join(dir, 'policy.mjs');
  writeFileSync(filePath, moduleSource, 'utf8');
  return (await import(pathToFileURL(filePath).href)) as {
    judge: (t: { before: unknown; after: unknown; input: unknown }) => Verdict;
    derive?: (s: { before: unknown; input: unknown }) => unknown;
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

const SUITE_SPECS = [
  { subject: 'multi-tenant-rbac', claim: 'role-hierarchy-access', probe: 'doc-updates' },
  { subject: 'saas-billing', claim: 'seat-quota-invoice', probe: 'invoice-transitions' },
  { subject: 'approval-workflow', claim: 'quorum-separation-of-duties', probe: 'review-transitions' },
  { subject: 'storage-media-gate', claim: 'media-upload-gate', probe: 'media-uploads' },
  { subject: 'rtdb-rate-presence', claim: 'rate-limit-and-presence', probe: 'presence-writes' },
  { subject: 'split-enforcement', claim: 'gateway-firestore-split', probe: 'split-writes' },
] as const;

const REQUIRED_SHARED_PINS = [
  '@oracle/adapters/_shared/v1/index.mjs',
  '@oracle/adapters/_shared/v1/runtime.mjs',
  '@oracle/adapters/_shared/v1/fixture.mjs',
  '@oracle/adapters/_shared/v1/score.mjs',
  '@oracle/adapters/_shared/v1/verify.mjs',
];

function probeDirOf(spec: (typeof SUITE_SPECS)[number]): string {
  return join(REAL_WORLD_ROOT, spec.subject, 'claims', spec.claim, 'v1', 'probes', spec.probe, 'v1');
}

function claimDirOf(spec: (typeof SUITE_SPECS)[number]): string {
  return join(REAL_WORLD_ROOT, spec.subject, 'claims', spec.claim, 'v1');
}

describe('Real-world policy-oracle suites metadata and pins', () => {
  test('all six suites declare native-model receipts, valid SHA-256 pins, and _shared/v1 deps', () => {
    expect(SUITE_SPECS).toHaveLength(6);
    for (const spec of SUITE_SPECS) {
      const claimPath = join(claimDirOf(spec), 'claim.json');
      const probeDir = probeDirOf(spec);
      const recipePath = join(probeDir, 'recipe.json');
      const obsPath = join(probeDir, 'observations/native.json');
      const rawPath = join(probeDir, 'raw/expected.json');

      const claim = readJson<{ authority: string; witness: string; description: string }>(claimPath);
      expect(claim.authority, spec.subject).toBe('native-model');
      expect(claim.witness, spec.subject).toBe('native-trace');
      expect(claim.description.length, spec.subject).toBeGreaterThan(20);

      const recipe = readJson<{ cases: string[]; pins: Record<string, string>; replay: string }>(recipePath);
      expect(recipe.replay).toBe('replay.mjs');
      expect(recipe.cases.length).toBeGreaterThanOrEqual(14);
      for (const sharedPin of REQUIRED_SHARED_PINS) {
        expect(recipe.pins[sharedPin], `${spec.subject} missing ${sharedPin}`).toMatch(/^[0-9a-f]{64}$/);
      }
      for (const [name, expectedHash] of Object.entries(recipe.pins)) {
        const target = name.startsWith('@oracle/')
          ? join(ORACLE_ROOT, name.slice('@oracle/'.length))
          : join(probeDir, name);
        expect(sha256(readFileSync(target)), `${spec.subject}:${name}`).toBe(expectedHash);
      }

      const inputDigest = sha256(
        Buffer.concat([readFileSync(claimPath), Buffer.from([0]), readFileSync(recipePath)]),
      );
      const obs = readJson<{
        authority: string;
        inputDigest: string;
        results: Record<string, string>;
        evidence: { path: string; sha256: string; pointers: Record<string, string> };
      }>(obsPath);
      const raw = readJson<{ decisions: Record<string, string> }>(rawPath);
      expect(obs.authority).toBe('native-model');
      expect(obs.inputDigest).toBe(inputDigest);
      expect(obs.evidence.sha256).toBe(sha256(readFileSync(rawPath)));
      expect(obs.results).toEqual(raw.decisions);
      expect(Object.keys(obs.results).sort()).toEqual([...recipe.cases].sort());
    }
  });
});

describe('Real-world policy suites end-to-end execution and temp .mjs parity', () => {
  test('1. multi-tenant-rbac lowers to Firestore, passes provePolicy fuzzing, and matches temp .mjs', async () => {
    const dir = probeDirOf(SUITE_SPECS[0]);
    const source = readFileSync(join(dir, 'policy.rules'), 'utf8');
    const cases = readJson<Array<{
      id: string;
      operation: 'update';
      path: string;
      auth: { uid: string; token: { tenantId: string; role: string; roleRank: number } } | null;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>>(join(dir, 'cases.json'));
    const { decisions } = readJson<{ decisions: Record<string, 'ALLOW' | 'DENY'> }>(join(dir, 'raw/expected.json'));

    const bindings = {
      'input.auth': 'request.auth',
      'input.uid': 'request.auth.uid',
      'input.tenant': 'request.auth.token.tenantId',
      'input.pathTenant': 'tenantId',
      'input.role': 'request.auth.token.role',
      'input.roleRank': 'request.auth.token.roleRank',
      'before.tenantId': 'resource.data.tenantId',
      'after.tenantId': 'request.resource.data.tenantId',
      'before.minWriteRank': 'resource.data.minWriteRank',
      'after.minWriteRank': 'request.resource.data.minWriteRank',
      'before.restricted': 'resource.data.restricted',
      'after.restricted': 'request.resource.data.restricted',
      'before.status': 'resource.data.status',
      'after.status': 'request.resource.data.status',
      'before.createdBy': 'resource.data.createdBy',
      'after.createdBy': 'request.resource.data.createdBy',
      'after.updatedBy': 'request.resource.data.updatedBy',
    };

    const compiled = compilePolicy(source);
    const tpl = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    function rbacPolicy() { return false; }',
      '    match /tenants/{tenantId}/docs/{docId} {',
      '      allow update: if rbacPolicy();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const bound = compiled.bind.firestore({
      rules: tpl,
      slot: 'rbacPolicy',
      placements: [{ path: '/databases/{db}/documents/tenants/{tenantId}/docs/{docId}', operation: 'update', bindings }],
    });
    const fsHandle = firestoreRules(bound.rules);
    const standMod = await importStandaloneModule(compiled.standaloneModule().moduleSource, 'rbac');

    for (const c of cases) {
      const pathTenant = c.path.split('/')[1] ?? '';
      const transition = {
        before: c.before,
        after: c.after,
        input: {
          auth: c.auth ? { uid: c.auth.uid } : null,
          uid: c.auth?.uid ?? null,
          tenant: c.auth?.token.tenantId ?? null,
          pathTenant,
          role: c.auth?.token.role ?? null,
          roleRank: c.auth?.token.roleRank ?? null,
        },
      };
      const [row] = fsHandle.simulate([{
        description: c.id,
        expectation: decisions[c.id]!,
        method: c.operation,
        path: c.path,
        auth: c.auth,
        resource: c.before,
        data: c.after,
      }]).cases;
      expect(row?.decision, c.id).toBe(decisions[c.id]!);
      expect(compiled.judge(transition).ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      expect(standMod.judge(transition).ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
    }

    const report = provePolicy(source, {
      firestore: bindings,
      fuzz: { seed: 101, cases: 60, includeAdversarial: true },
    });
    expect(report.ok).toBe(true);
    expect(report.fuzz.divergences).toEqual([]);
    expect(report.placement.firestore?.every((r) => r.enforcement === 'standalone and database')).toBe(true);
  });

  test('2. saas-billing enforces derive + bounded.fold + integer cents, fatal limits, and mutant kill', async () => {
    const dir = probeDirOf(SUITE_SPECS[1]);
    const source = readFileSync(join(dir, 'policy.rules'), 'utf8');
    const mutantSource = readFileSync(join(dir, 'mutant.rules'), 'utf8');
    const cases = readJson<Array<{ id: string; transition: { before: unknown; after: unknown; input: unknown } }>>(
      join(dir, 'cases.json'),
    );
    const { decisions } = readJson<{ decisions: Record<string, 'ALLOW' | 'DENY'> }>(join(dir, 'raw/expected.json'));

    const compiled = compilePolicy(source);
    const mutant = compilePolicy(mutantSource);
    const standMod = await importStandaloneModule(compiled.standaloneModule().moduleSource, 'billing');

    const killed: string[] = [];
    for (const c of cases) {
      const v = compiled.judge(c.transition);
      const sv = standMod.judge(c.transition);
      expect(v.ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      expect(sv.ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      if (c.id === 'over-bound-line-items-denied') {
        expect(v.ok).toBe(false);
        if (!v.ok) {
          expect(v.fatal).toBe(true);
          expect(v.trace?.outcome).toBe('resource-limit');
        }
      }
      if (c.id === 'tampered-total-off-by-one-cent-denied') {
        expect(v.ok).toBe(false);
        if (!v.ok) {
          expect(v.requirement).toBe('invoiceTotalsExact');
          expect(v.trace?.derived).toMatchObject({ discountCents: 2049, taxCents: 1183, totalCents: 15533 });
        }
      }
      const mv = mutant.judge(c.transition);
      if ((mv.ok ? 'ALLOW' : 'DENY') !== decisions[c.id]!) killed.push(c.id);
    }
    expect(killed.length).toBeGreaterThanOrEqual(3);

    const report = provePolicy(source, {
      scenarios: cases.map((c) => ({
        name: c.id,
        transition: c.transition,
        expectOk: decisions[c.id] === 'ALLOW',
      })),
      fuzz: { seed: 202, cases: 60, includeAdversarial: true },
    });
    expect(report.ok).toBe(true);
    expect(report.staticCheck.hasDerive).toBe(true);
    expect(report.scenarios.passed).toBe(cases.length);
    expect(report.fuzz.divergences).toEqual([]);
  });

  test('3. approval-workflow enforces quorum, distinct reviewers, separation of duties, and mutant kill', async () => {
    const dir = probeDirOf(SUITE_SPECS[2]);
    const source = readFileSync(join(dir, 'policy.rules'), 'utf8');
    const mutantSource = readFileSync(join(dir, 'mutant.rules'), 'utf8');
    const cases = readJson<Array<{ id: string; transition: { before: unknown; after: unknown; input: unknown } }>>(
      join(dir, 'cases.json'),
    );
    const { decisions } = readJson<{ decisions: Record<string, 'ALLOW' | 'DENY'> }>(join(dir, 'raw/expected.json'));

    const compiled = compilePolicy(source);
    const mutant = compilePolicy(mutantSource);
    const standMod = await importStandaloneModule(compiled.standaloneModule().moduleSource, 'approval');

    const killed: string[] = [];
    for (const c of cases) {
      const v = compiled.judge(c.transition);
      const sv = standMod.judge(c.transition);
      expect(v.ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      expect(sv.ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      if ((mutant.judge(c.transition).ok ? 'ALLOW' : 'DENY') !== decisions[c.id]!) killed.push(c.id);
    }
    expect(killed).toContain('author-self-approval-denied');
    expect(killed).toContain('duplicate-reviewer-stuffing-denied');
    expect(killed).toContain('missing-security-signoff-denied');

    const report = provePolicy(source, {
      scenarios: cases.map((c) => ({
        name: c.id,
        transition: c.transition,
        expectOk: decisions[c.id] === 'ALLOW',
      })),
      fuzz: { seed: 303, cases: 50, includeAdversarial: true },
    });
    expect(report.ok).toBe(true);
    expect(report.fuzz.divergences).toEqual([]);
  });

  test('4. storage-media-gate lowers via bind.storage() and matches temp .mjs module', async () => {
    const dir = probeDirOf(SUITE_SPECS[3]);
    const source = readFileSync(join(dir, 'policy.rules'), 'utf8');
    const cases = readJson<Array<{
      id: string;
      method: 'create';
      path: string;
      auth: { uid: string; token: { tenantId: string } } | null;
      requestResource: { contentType: string; size: number; metadata: Record<string, string> };
    }>>(join(dir, 'cases.json'));
    const { decisions } = readJson<{ decisions: Record<string, 'ALLOW' | 'DENY'> }>(join(dir, 'raw/expected.json'));

    const template = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    function mediaUploadPolicy() { return false; }',
      '    match /tenants/{tenantId}/users/{uid}/media/{file} {',
      '      allow create: if mediaUploadPolicy();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const compiled = compilePolicy(source);
    const rules = compiled.bind.storage({
      rules: template,
      slot: 'mediaUploadPolicy',
      placements: [{
        path: '/b/{bucket}/o/tenants/{tenantId}/users/{uid}/media/{file}',
        operation: 'create',
        bindings: {
          'input.auth': 'request.auth',
          'input.pathUid': 'uid',
          'input.pathTenant': 'tenantId',
          after: 'request.resource',
        },
      }],
    }).rules;
    const handle = storageRules(rules, { bucket: 'real-world-media-bucket' });
    const standMod = await importStandaloneModule(compiled.standaloneModule().moduleSource, 'storage');

    for (const c of cases) {
      const [row] = handle.simulate([{
        description: c.id,
        expectation: decisions[c.id]!,
        method: c.method,
        path: c.path,
        auth: c.auth,
        requestResource: c.requestResource,
      }]).cases;
      expect(row?.unsupported).toBe(false);
      expect(row?.decision, c.id).toBe(decisions[c.id]!);
      if (c.path.startsWith('tenants/')) {
        const parts = c.path.split('/');
        const t = {
          before: {},
          after: c.requestResource,
          input: { auth: c.auth, pathTenant: parts[1], pathUid: parts[3] },
        };
        expect(standMod.judge(t).ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      }
    }

    const report = provePolicy(source, { fuzz: { seed: 404, cases: 50, includeAdversarial: true } });
    expect(report.ok).toBe(true);
    expect(report.fuzz.divergences).toEqual([]);
  });

  test('5. rtdb-rate-presence lowers via rtdb(), verifies bind.rtdb(), and passes fuzzing', async () => {
    const dir = probeDirOf(SUITE_SPECS[4]);
    const source = readFileSync(join(dir, 'policy.rules'), 'utf8');
    const cases = readJson<Array<{
      id: string;
      operation: 'write';
      path: string;
      auth: { uid: string } | null;
      data: { presence: { alice: Record<string, unknown> } };
      newData: Record<string, unknown>;
    }>>(join(dir, 'cases.json'));
    const { decisions } = readJson<{ decisions: Record<string, 'ALLOW' | 'DENY'> }>(join(dir, 'raw/expected.json'));

    const bindings = { before: 'data', after: 'newData' } as const;
    const compiled = compilePolicy(source);
    const rows = compiled.rtdb(bindings, 'complete');
    expect(rows.every((r) => r.enforcement === 'gateway and database')).toBe(true);
    const tree = {
      rules: {
        '.read': false,
        '.write': false,
        presence: {
          $uid: {
            '.write': 'auth != null && auth.uid == $uid && newData.exists()',
            '.validate': rows.map((r) => `(${r.predicate})`).join(' && '),
          },
        },
      },
    };
    compiled.bind.rtdb({ path: '/presence/$uid', bindings, mode: 'complete' }).verify(tree);
    const handle = rtdbRules(tree);
    const standMod = await importStandaloneModule(compiled.standaloneModule().moduleSource, 'rtdb');

    for (const c of cases) {
      const [row] = handle.simulate([{
        description: c.id,
        expectation: decisions[c.id]!,
        operation: c.operation,
        path: c.path,
        auth: c.auth,
        data: c.data,
        newData: c.newData,
      }]).cases;
      expect(row?.unsupported).toBe(false);
      expect(row?.decision, c.id).toBe(decisions[c.id]!);
      if (c.auth?.uid === 'alice') {
        const t = { before: c.data.presence.alice, after: c.newData, input: {} };
        expect(standMod.judge(t).ok ? 'ALLOW' : 'DENY', c.id).toBe(decisions[c.id]!);
      }
    }

    const report = provePolicy(source, {
      rtdb: bindings,
      fuzz: { seed: 505, cases: 60, includeAdversarial: true },
    });
    expect(report.ok).toBe(true);
    expect(report.fuzz.divergences).toEqual([]);
  });
});
