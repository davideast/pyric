// Unit tests for experiments/policy-oracle/adapters/_shared/v1.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rulesPkg from '../../../../../packages/rules/src/index.js';
import * as policyPkg from '../../../../../packages/rules/src/policy/index.js';
import * as storageInternalPkg from '../../../../../packages/rules/src/internal/storage.js';
import {
  canonicalJson,
  computeInputDigest,
  createRulesRuntime,
  defineProbeFixtures,
  scoreFirestoreProbe,
  scoreRtdbProbe,
  scoreStandaloneProbe,
  scoreStorageProbe,
  sha256,
  verifyNativeTraceReceipt,
  verifyRtdbReceipt,
  verifyStorageReceipt,
} from './index.mjs';

const directRuntime = createRulesRuntime({
  directModules: {
    '.': rulesPkg,
    'experimental/policy': policyPkg,
    'internal/storage': storageInternalPkg,
  },
});

describe('policy-oracle _shared/v1 helpers', () => {
  test('canonicalJson, sha256, computeInputDigest, and defineProbeFixtures', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(computeInputDigest('{"a":1}\n', '{"b":2}\n')).toBe(
      sha256(Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0]), Buffer.from('{"b":2}\n')])),
    );
    const fixtures = defineProbeFixtures({
      'case-a': { x: 1 },
      'case-b': { x: 2 },
    });
    expect(fixtures.ids).toEqual(['case-a', 'case-b']);
    expect(() => defineProbeFixtures([{ id: 'dup' }, { id: 'dup' }])).toThrow(/duplicate/);
  });

  test('scoreStorageProbe evaluates stateful and stateless Storage rules and catches mutations', async () => {
    const candidateRules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /clips/{file} {',
      '      allow create: if request.auth != null && request.resource.size < 1024 && request.resource.contentType == "audio/wav";',
      '      allow delete: if request.auth != null && resource.size < 1024;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const mutantRules = candidateRules.replace('size < 1024', 'size <= 1024');
    const out = await scoreStorageProbe({
      runtime: directRuntime,
      bucket: 'demo-bucket',
      candidateRules,
      mutantRules,
      stateful: true,
      seedObjects: { 'clips/old.wav': { size: 512, contentType: 'audio/wav' } },
      cases: [
        { id: 'under-limit', method: 'create', path: 'clips/a.wav', auth: { uid: 'u1' }, requestResource: { size: 500, contentType: 'audio/wav' } },
        { id: 'at-limit', method: 'create', path: 'clips/b.wav', auth: { uid: 'u1' }, requestResource: { size: 1024, contentType: 'audio/wav' } },
        { id: 'wrong-mime', method: 'create', path: 'clips/c.wav', auth: { uid: 'u1' }, requestResource: { size: 500, contentType: 'image/png' } },
        { id: 'delete-seeded', method: 'delete', path: 'clips/old.wav', auth: { uid: 'u1' } },
      ],
    });
    expect(out.candidate).toEqual({
      'under-limit': 'ALLOW',
      'at-limit': 'DENY',
      'wrong-mime': 'DENY',
      'delete-seeded': 'ALLOW',
    });
    expect(out.mutant['at-limit']).toBe('ALLOW');
    expect(out.artifacts.rulesSha256).toBe(sha256(candidateRules));
  });

  test('scoreRtdbProbe supports compiled policy lowering and graceful older-package fallback', async () => {
    const policySource = [
      'transition counter {',
      '  require step {',
      '    return before.n is int && before.n >= 0 && before.n <= 9007199254740991',
      '      && after.n is int && after.n >= 0 && after.n <= 9007199254740991',
      '      && after.n == before.n + 1;',
      '  }',
      '}',
    ].join('\n');
    const out = await scoreRtdbProbe({
      runtime: directRuntime,
      compileCandidate: async (rt) => {
        const { compilePolicy } = await rt.policy();
        const [row] = compilePolicy(policySource).rtdb({ 'before.n': 'data', 'after.n': 'newData' }, 'complete');
        return { rules: { counter: { '.write': true, '.validate': row.predicate } } };
      },
      compileMutant: () => ({ rules: { counter: { '.write': true, '.validate': 'newData.isNumber()' } } }),
      cases: [
        { id: 'step-one', path: '/counter', data: { counter: 5 }, newData: 6 },
        { id: 'step-two', path: '/counter', data: { counter: 5 }, newData: 7 },
      ],
    });
    expect(out.candidate).toEqual({ 'step-one': 'ALLOW', 'step-two': 'DENY' });
    expect(out.mutant).toEqual({ 'step-one': 'ALLOW', 'step-two': 'ALLOW' });

    const unsupported = await scoreRtdbProbe({
      runtime: directRuntime,
      compileCandidate: () => {
        throw new Error('policy.rtdb unavailable in legacy package');
      },
      cases: [{ id: 'only', path: '/x', data: {}, newData: 1 }],
    });
    expect(unsupported.candidate).toEqual({ only: 'UNSUPPORTED' });
    expect(unsupported.artifacts.compilerError).toContain('legacy package');
  });

  test('scoreFirestoreProbe and scoreStandaloneProbe detect mutations', async () => {
    const fsRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /items/{id} {',
      '      allow update: if request.resource.data.n == resource.data.n + 1;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const fsOut = await scoreFirestoreProbe({
      runtime: directRuntime,
      candidateRules: fsRules,
      mutantRules: fsRules.replace('+ 1', '+ 2'),
      cases: [
        { id: 'plus-one', method: 'update', path: 'items/a', resource: { n: 1 }, data: { n: 2 } },
        { id: 'plus-two', method: 'update', path: 'items/a', resource: { n: 1 }, data: { n: 3 } },
      ],
    });
    expect(fsOut.candidate).toEqual({ 'plus-one': 'ALLOW', 'plus-two': 'DENY' });
    expect(fsOut.mutant).toEqual({ 'plus-one': 'DENY', 'plus-two': 'ALLOW' });

    const standaloneOut = await scoreStandaloneProbe({
      runtime: directRuntime,
      compileCandidate: async (rt) => {
        const { compilePolicy } = await rt.policy();
        return compilePolicy('transition step { require inc { return after.n == before.n + 1; } }');
      },
      evaluate: (compiled, c) => compiled.judge(c.transition).ok,
      mutateCase: (c) => ({ ...c, transition: { ...c.transition, after: { n: c.transition.after.n + 1 } } }),
      cases: [
        { id: 'valid', transition: { before: { n: 1 }, after: { n: 2 }, input: {} } },
        { id: 'invalid', transition: { before: { n: 1 }, after: { n: 3 }, input: {} } },
      ],
    });
    expect(standaloneOut.candidate).toEqual({ valid: true, invalid: false });
    expect(standaloneOut.mutant).toEqual({ valid: false, invalid: false });
  });

  test('verifyRtdbReceipt, verifyStorageReceipt, and verifyNativeTraceReceipt validate evidence', () => {
    const runId = '11111111-2222-3333-4444-555555555555';
    const rulesBytes = Buffer.from('{"rules":{}}\n');
    const rtdbReceipt = {
      runId,
      project: 'demo-proj',
      sdk: '12.19.0',
      created: {
        name: 'projects/999/locations/us-central1/instances/demo-11111111',
        project: 'projects/999',
        databaseUrl: 'https://demo-11111111.firebaseio.com',
        type: 'USER_DATABASE',
        state: 'ACTIVE',
      },
      cleanup: {
        instance: {
          name: 'projects/999/locations/us-central1/instances/demo-11111111',
          project: 'projects/999',
          databaseUrl: 'https://demo-11111111.firebaseio.com',
          type: 'USER_DATABASE',
          state: 'DELETED',
        },
        identityDeleted: true,
        closed: { status: 401, body: { error: 'Permission denied' }, etag: null },
      },
      identities: {
        host: { uid: 'hostUid12345678901234', audience: 'demo-proj', issuer: 'https://securetoken.google.com/demo-proj', provider: 'anonymous' },
      },
      releases: {
        generated: { sourceSha256: sha256(rulesBytes), activeRulesMatchedBeforeAndAfter: true },
      },
      rows: {
        allowCase: {
          path: 'items/hostUid12345678901234',
          method: 'PATCH',
          submitted: { n: 2 },
          before: { status: 200, etag: 'AAAA', body: { n: 1 } },
          reply: { status: 200, body: { n: 2 } },
          after: { status: 200, etag: 'BBBB', body: { n: 2 } },
          decision: 'ALLOW',
        },
        denyCase: {
          path: 'items/hostUid12345678901234',
          method: 'PATCH',
          submitted: { n: 9 },
          before: { status: 200, etag: 'AAAA', body: { n: 1 } },
          reply: { status: 401, body: { error: 'Permission denied' }, etag: null },
          after: { status: 200, etag: 'AAAA', body: { n: 1 } },
          decision: 'DENY',
        },
      },
    };
    expect(verifyRtdbReceipt(rtdbReceipt, {
      project: 'demo-proj',
      projectNumber: '999',
      sdk: '12.19.0',
      instanceId: (id) => 'demo-' + id.slice(0, 8),
      profileRules: { generated: rulesBytes },
      rows: {
        allowCase: { path: (uid) => 'items/' + uid, method: 'PATCH', submitted: { n: 2 }, before: { n: 1 }, expectedAfter: { n: 2 } },
        denyCase: { path: (uid) => 'items/' + uid, method: 'PATCH', submitted: { n: 9 }, before: { n: 1 } },
      },
    })).toEqual({ allowCase: 'ALLOW', denyCase: 'DENY' });

    const storageRulesBytes = Buffer.from("rules_version = '2';\n");
    const objSnap = {
      name: 'clips/a.wav',
      bucket: 'demo-proj-b-' + runId,
      generation: '100',
      metageneration: '1',
      size: '128',
      sha256: sha256('payload'),
      contentType: 'audio/wav',
      updated: '2026-01-01T00:00:02.000Z',
    };
    const storageReceipt = {
      runId,
      project: 'demo-proj',
      endpoint: 'firebasestorage.googleapis.com',
      bucket: 'demo-proj-b-' + runId,
      rulesSha256: sha256(storageRulesBytes),
      identity: { uid: 'userUid123', audience: 'demo-proj', issuer: 'https://securetoken.google.com/demo-proj', provider: 'anonymous' },
      rows: {
        upload: {
          path: 'clips/a.wav',
          op: 'upload',
          actorUid: 'userUid123',
          at: '2026-01-01T00:00:01.000Z',
          finishedAt: '2026-01-01T00:00:02.000Z',
          before: null,
          after: objSnap,
          decision: 'ALLOW',
          code: 'ok',
        },
        anonDeny: {
          path: 'clips/a.wav',
          op: 'delete',
          actorUid: null,
          at: '2026-01-01T00:00:03.000Z',
          finishedAt: '2026-01-01T00:00:04.000Z',
          before: objSnap,
          after: objSnap,
          decision: 'DENY',
          code: 'storage/unauthenticated',
        },
      },
    };
    expect(verifyStorageReceipt(storageReceipt, {
      project: 'demo-proj',
      bucketFor: (id) => 'demo-proj-b-' + id,
      rulesBytes: storageRulesBytes,
      cases: [
        { id: 'upload', op: 'upload', actor: 'signed', path: 'clips/a.wav', size: 128, mime: 'audio/wav' },
        { id: 'anonDeny', op: 'delete', actor: 'out', path: 'clips/a.wav' },
      ],
    })).toEqual({ upload: 'ALLOW', anonDeny: 'DENY' });

    expect(verifyNativeTraceReceipt({ cases: { a: true, b: false } }, ['a', 'b'])).toEqual({ a: true, b: false });
  });

  test('integrates end-to-end with oracle.py --replay on a scratch native-model probe', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'oracle-shared-test-'));
    try {
      const oracleDir = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
      const sharedDir = join(scratch, 'adapters/_shared/v1');
      mkdirSync(sharedDir, { recursive: true });
      for (const file of ['fixture.mjs', 'runtime.mjs', 'score.mjs', 'verify.mjs', 'index.mjs']) {
        writeFileSync(join(sharedDir, file), readFileSync(join(oracleDir, 'adapters/_shared/v1', file)));
      }
      const claimDir = join(scratch, 'suites/demo/shared/claims/smoke/v1');
      const probeDir = join(claimDir, 'probes/basic/v1');
      mkdirSync(join(probeDir, 'observations'), { recursive: true });
      mkdirSync(join(probeDir, 'raw'), { recursive: true });
      mkdirSync(join(claimDir, 'obligations'), { recursive: true });

      const claimBytes = JSON.stringify({ description: 'Smoke shared probe', authority: 'native-model' }) + '\n';
      writeFileSync(join(claimDir, 'claim.json'), claimBytes);
      writeFileSync(join(claimDir, 'obligations/basic.json'), JSON.stringify({ probe: 'basic/v1' }) + '\n');

      const replayCode = [
        "import { join } from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        "const shared = await import(pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href);",
        "shared.emitProbeOutput({ candidate: { ok: true, bad: false }, mutant: { ok: false, bad: false } }, ['ok', 'bad']);",
      ].join('\n') + '\n';
      writeFileSync(join(probeDir, 'replay.mjs'), replayCode);

      const pins = { 'replay.mjs': sha256(replayCode) };
      for (const file of ['fixture.mjs', 'runtime.mjs', 'score.mjs', 'verify.mjs', 'index.mjs']) {
        const ref = '@oracle/adapters/_shared/v1/' + file;
        pins[ref] = sha256(readFileSync(join(sharedDir, file)));
      }
      const recipeBytes = JSON.stringify({
        source: { repo: 'example/demo', revision: 'a'.repeat(40), path: 'demo.ts' },
        cases: ['ok', 'bad'],
        pins,
        replay: 'replay.mjs',
      }) + '\n';
      writeFileSync(join(probeDir, 'recipe.json'), recipeBytes);

      const rawBytes = JSON.stringify({ ok: true, bad: false }) + '\n';
      writeFileSync(join(probeDir, 'raw/run1.json'), rawBytes);
      writeFileSync(join(probeDir, 'observations/run1.json'), JSON.stringify({
        authority: 'native-model',
        inputDigest: computeInputDigest(claimBytes, recipeBytes),
        results: { ok: true, bad: false },
        evidence: { path: 'raw/run1.json', sha256: sha256(rawBytes), pointers: { ok: '/ok', bad: '/bad' } },
      }) + '\n');

      const stdout = execFileSync('python3', [join(oracleDir, 'core/oracle.py'), '--root', scratch, '--replay'], {
        encoding: 'utf8',
      });
      const report = JSON.parse(stdout);
      expect(report.claims['demo/shared/smoke/v1'].status).toBe('conforms');
      expect(report.claims['demo/shared/smoke/v1'].mutationDetected).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
