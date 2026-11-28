import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_USAGE,
  runPolicy,
  type PolicyEmitReport,
} from '../../src/cli/policy/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-emit-'));
  tempDirs.push(dir);
  return dir;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
}

async function runEmit(argv: string[]) {
  let out = '';
  let err = '';
  const code = await runPolicy(parseArgs(['policy', 'emit', ...argv]), {
    stdout: { write(s: string) { out += s; } },
    stderr: { write(s: string) { err += s; } },
  });
  return { code, out, err };
}

const SIZE_POLICY = `transition gateWrite {
  require positiveSize {
    return after.size is int && after.size > 0 && after.size <= 4096;
  }
}
`;

const SPLIT_POLICY = `use extension derive;
use extension bounded;

transition checkout {
  derive {
    let total = bounded.fold(input.items, 0, (acc, item) => acc + item.price, 8);
    return {'total': total};
  }
  require ownerPreserved {
    return after.owner == before.owner;
  }
  require totalMatches {
    return after.total == derived.total;
  }
}
`;

describe('pyric policy emit', () => {
  it('emits standalone ESM plus Firestore, Storage, and RTDB rules in one command', async () => {
    const dir = makeTempDir();
    const outDir = join(dir, 'dist-policy');
    const manifestPath = join(dir, 'manifest.json');
    const pol = join(dir, 'gate.policy');
    const fsFile = join(dir, 'fs.json');
    const stFile = join(dir, 'st.json');
    const rtdbFile = join(dir, 'rtdb.json');

    writeFileSync(pol, SIZE_POLICY);
    writeFileSync(fsFile, JSON.stringify({ 'after.size': 'request.resource.data.size' }));
    writeFileSync(stFile, JSON.stringify({ 'after.size': 'request.resource.size' }));
    writeFileSync(
      rtdbFile,
      JSON.stringify({ 'after.size': { snapshot: 'newData', path: 'size', type: 'number' } }),
    );

    const res = await runEmit([
      pol,
      '--out-dir',
      outDir,
      '--firestore-bindings',
      fsFile,
      '--storage-bindings',
      stFile,
      '--rtdb-bindings',
      rtdbFile,
      '--rtdb-path',
      '/uploads/$id',
      '--manifest',
      manifestPath,
      '--json',
    ]);
    expect(res.code).toBe(POLICY_EXIT_OK);
    expect(res.err).toBe('');
    const report = JSON.parse(res.out) as PolicyEmitReport;
    expect(report.schema).toBe('pyric.policy.emit.v1');
    expect(report.ok).toBe(true);
    expect(report.name).toBe('gateWrite');
    expect(report.standalone.esmVerified).toBe(true);
    expect(report.artifacts.map((a) => a.fileName)).toEqual([
      'gateWrite.mjs',
      'gateWrite.firestore.rules',
      'gateWrite.storage.rules',
      'gateWrite.rtdb.rules.json',
    ]);

    for (const art of report.artifacts) {
      expect(art.written).toBe(true);
      expect(art.path).not.toBeNull();
      expect(existsSync(art.path!)).toBe(true);
      expect(sha256File(art.path!)).toBe(art.sha256);
    }

    // Load emitted standalone ES module via real file URL (no data: URI).
    const modPath = join(outDir, 'gateWrite.mjs');
    const mod = (await import(pathToFileURL(modPath).href)) as {
      judge(t: { before: unknown; after: unknown; input: unknown }): { ok: boolean };
    };
    expect(mod.judge({ before: {}, after: { size: 100 }, input: {} }).ok).toBe(true);
    expect(mod.judge({ before: {}, after: { size: 5000 }, input: {} }).ok).toBe(false);

    const fsText = readFileSync(join(outDir, 'gateWrite.firestore.rules'), 'utf8');
    expect(fsText).toContain("rules_version = '2+modules';");
    expect(fsText).toContain('export function gateWrite()');

    const stText = readFileSync(join(outDir, 'gateWrite.storage.rules'), 'utf8');
    expect(stText).toContain("rules_version = '2+modules';");
    expect(stText).toContain('request.resource.size');

    const rtdbDoc = JSON.parse(readFileSync(join(outDir, 'gateWrite.rtdb.rules.json'), 'utf8'));
    expect(typeof rtdbDoc.rules.uploads.$id['.validate']).toBe('string');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PolicyEmitReport;
    expect(manifest.artifacts).toHaveLength(4);
  });

  it('composes Firestore and Storage ruleset templates via rulesFile', async () => {
    const dir = makeTempDir();
    const outDir = join(dir, 'composed');
    const pol = join(dir, 'gate.policy');
    const fsTplRules = join(dir, 'fs-template.rules');
    const fsTpl = join(dir, 'fs-template.json');
    const stTplRules = join(dir, 'st-template.rules');
    const stTpl = join(dir, 'st-template.json');

    writeFileSync(pol, SIZE_POLICY);
    writeFileSync(
      fsTplRules,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    function policySlot() { return false; }',
        '    match /items/{id} {',
        '      allow create: if request.auth != null && policySlot();',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      fsTpl,
      JSON.stringify({
        slot: 'policySlot',
        rulesFile: './fs-template.rules',
        placements: [
          {
            path: '/databases/{database}/documents/items/{id}',
            operation: 'create',
            bindings: { 'after.size': 'request.resource.data.size' },
          },
        ],
      }),
    );

    writeFileSync(
      stTplRules,
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    function uploadGate() { return false; }',
        '    match /uploads/{file} {',
        '      allow create: if request.auth != null && uploadGate();',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      stTpl,
      JSON.stringify({
        slot: 'uploadGate',
        rulesFile: './st-template.rules',
        placements: [
          {
            path: '/b/{bucket}/o/uploads/{file}',
            operation: 'create',
            bindings: { 'after.size': 'request.resource.size' },
          },
        ],
      }),
    );

    const res = await runEmit([
      pol,
      '--out-dir',
      outDir,
      '--name',
      'composed',
      '--firestore-template',
      fsTpl,
      '--storage-template',
      stTpl,
      '--json',
    ]);
    expect(res.code).toBe(POLICY_EXIT_OK);
    const report = JSON.parse(res.out) as PolicyEmitReport;
    expect(report.artifacts.map((a) => [a.fileName, a.format])).toEqual([
      ['composed.mjs', 'esm'],
      ['composed.firestore.rules', 'firestore-rules'],
      ['composed.storage.rules', 'storage-rules'],
    ]);
    expect(readFileSync(join(outDir, 'composed.firestore.rules'), 'utf8')).toContain(
      'request.resource.data.size',
    );
    expect(readFileSync(join(outDir, 'composed.storage.rules'), 'utf8')).toContain(
      'request.resource.size',
    );
  });

  it('refuses to write partial files in complete mode, and supports split enforcement in mixed mode', async () => {
    const dir = makeTempDir();
    const completeOut = join(dir, 'complete-out');
    const mixedOut = join(dir, 'mixed-out');
    const pol = join(dir, 'checkout.policy');
    const fsFile = join(dir, 'fs.json');
    const rtdbFile = join(dir, 'rtdb.json');

    writeFileSync(pol, SPLIT_POLICY);
    writeFileSync(
      fsFile,
      JSON.stringify({
        'before.owner': 'resource.data.owner',
        'after.owner': 'request.resource.data.owner',
        'after.total': 'request.resource.data.total',
      }),
    );
    writeFileSync(
      rtdbFile,
      JSON.stringify({
        'before.owner': { snapshot: 'data', path: 'owner', type: 'string' },
        'after.owner': { snapshot: 'newData', path: 'owner', type: 'string' },
      }),
    );

    const fail = await runEmit([
      pol,
      '--out-dir',
      completeOut,
      '--firestore-bindings',
      fsFile,
      '--json',
    ]);
    expect(fail.code).toBe(POLICY_EXIT_PLACEMENT);
    expect(existsSync(completeOut)).toBe(false);
    expect(JSON.parse(fail.out).artifacts).toEqual([]);

    const mixed = await runEmit([
      pol,
      '--out-dir',
      mixedOut,
      '--mode',
      'mixed',
      '--firestore-bindings',
      fsFile,
      '--rtdb-bindings',
      rtdbFile,
      '--rtdb-path',
      '/orders/$id',
      '--json',
    ]);
    expect(mixed.code).toBe(POLICY_EXIT_OK);
    const mixedReport = JSON.parse(mixed.out) as PolicyEmitReport;
    const fsArt = mixedReport.artifacts.find((a) => a.target === 'firestore');
    expect(fsArt?.complete).toBe(false);
    expect(fsArt?.loweredRequirements).toEqual(['ownerPreserved']);
    expect(fsArt?.residualRequirements).toEqual(['totalMatches']);
    const fsSrc = readFileSync(join(mixedOut, 'checkout.firestore.rules'), 'utf8');
    expect(fsSrc).toContain('request.resource.data.owner == resource.data.owner');

    const rtdbArt = mixedReport.artifacts.find((a) => a.target === 'rtdb');
    expect(rtdbArt?.complete).toBe(false);
    expect(rtdbArt?.loweredRequirements).toEqual(['ownerPreserved']);
    expect(rtdbArt?.residualRequirements).toEqual(['totalMatches']);

    // Standalone .mjs enforces the full policy including derive + bounded.fold.
    const mod = (await import(pathToFileURL(join(mixedOut, 'checkout.mjs')).href)) as {
      derive(s: { before: unknown; input: unknown }): { total: number };
      judge(t: { before: unknown; after: unknown; input: unknown }): { ok: boolean; requirement?: string };
    };
    expect(mod.derive({ before: {}, input: { items: [{ price: 25 }, { price: 15 }] } })).toEqual({
      total: 40,
    });
    expect(
      mod.judge({
        before: { owner: 'u1' },
        after: { owner: 'u1', total: 40 },
        input: { items: [{ price: 25 }, { price: 15 }] },
      }).ok,
    ).toBe(true);
    expect(
      mod.judge({
        before: { owner: 'u1' },
        after: { owner: 'u1', total: 39 },
        input: { items: [{ price: 25 }, { price: 15 }] },
      }).requirement,
    ).toBe('totalMatches');
  });

  it('supports --no-write dry run, --no-standalone, function, and module targets', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'gate.policy');
    writeFileSync(pol, SIZE_POLICY);

    const noOut = await runEmit([pol, '--json']);
    expect(noOut.code).toBe(POLICY_EXIT_USAGE);

    const dry = await runEmit([pol, '--no-write', '--json']);
    expect(dry.code).toBe(POLICY_EXIT_OK);
    const dryReport = JSON.parse(dry.out) as PolicyEmitReport;
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.artifacts[0]?.written).toBe(false);
    expect(dryReport.artifacts[0]?.path).toBeNull();

    const missingBindings = await runEmit([pol, '--no-write', '--targets', 'firestore', '--json']);
    expect(missingBindings.code).toBe(POLICY_EXIT_USAGE);

    const fnPol = join(dir, 'fn.policy');
    const fnOut = join(dir, 'fn-out');
    const fnRtdb = join(dir, 'fn-rtdb.json');
    writeFileSync(fnPol, 'function inRange(x) { return x >= 0 && x <= 10; }\n');
    writeFileSync(fnRtdb, JSON.stringify({ x: { snapshot: 'newData', path: 'x', type: 'number' } }));
    const fnRes = await runEmit([
      fnPol,
      '--out-dir',
      fnOut,
      '--targets',
      'firestore,rtdb',
      '--rtdb-bindings',
      fnRtdb,
      '--json',
    ]);
    expect(fnRes.code).toBe(POLICY_EXIT_OK);
    expect(JSON.parse(fnRes.out).artifacts.map((a: { target: string }) => a.target)).toEqual([
      'firestore',
      'rtdb',
    ]);

    const modPol = join(dir, 'mod.policy');
    const modOut = join(dir, 'mod-out');
    writeFileSync(
      modPol,
      'use extension bounded;\nexport function countPos(xs) { return bounded.count(xs, x => x > 0, 8); }\n',
    );
    const modRes = await runEmit([modPol, '--out-dir', modOut, '--json']);
    expect(modRes.code).toBe(POLICY_EXIT_OK);
    const modLoaded = (await import(pathToFileURL(join(modOut, 'mod.mjs')).href)) as {
      countPos(xs: number[]): number;
    };
    expect(modLoaded.countPos([-1, 0, 2, 5])).toBe(2);

    const modBadTarget = await runEmit([modPol, '--no-write', '--targets', 'firestore', '--json']);
    expect(modBadTarget.code).toBe(POLICY_EXIT_PLACEMENT);

    const emptyTargets = await runEmit([pol, '--no-write', '--no-standalone', '--json']);
    expect(emptyTargets.code).toBe(POLICY_EXIT_USAGE);
  });

  it('warns with TARGET_SKIPPED in mixed mode when zero requirements lower', async () => {
    const dir = makeTempDir();
    const outDir = join(dir, 'out');
    const pol = join(dir, 'only-bounded.policy');
    const fsFile = join(dir, 'fs.json');
    writeFileSync(
      pol,
      [
        'use extension bounded;',
        'transition quorum {',
        '  require enough {',
        '    return bounded.count(input.votes, v => v == true, 8) >= 2;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(fsFile, '{}');

    const res = await runEmit([
      pol,
      '--out-dir',
      outDir,
      '--mode',
      'mixed',
      '--firestore-bindings',
      fsFile,
      '--json',
    ]);
    expect(res.code).toBe(POLICY_EXIT_OK);
    const report = JSON.parse(res.out) as PolicyEmitReport;
    expect(report.artifacts.map((a) => a.target)).toEqual(['standalone']);
    expect(report.diagnostics[0]?.code).toBe('TARGET_SKIPPED');
    expect(report.diagnostics[0]?.severity).toBe('warning');
  });

  it('reports IO_ERROR on write failure, TEMPLATE_COMPOSE_ERROR on bad template, and emits both template + module', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'gate.policy');
    const fsBindings = join(dir, 'fs.json');
    const badTpl = join(dir, 'bad-tpl.json');
    const okTpl = join(dir, 'ok-tpl.json');
    const stMixedPol = join(dir, 'st-mixed.policy');
    const stBindings = join(dir, 'st.json');

    writeFileSync(pol, SIZE_POLICY);
    writeFileSync(fsBindings, JSON.stringify({ 'after.size': 'request.resource.data.size' }));
    writeFileSync(
      badTpl,
      JSON.stringify({
        slot: 'missingSlot',
        rules: "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow create: if false; } } }",
        placements: [],
      }),
    );
    writeFileSync(
      okTpl,
      JSON.stringify({
        slot: 'policySlot',
        rules: [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{db}/documents {',
          '    function policySlot() { return false; }',
          '    match /items/{id} { allow create: if policySlot(); }',
          '  }',
          '}',
        ].join('\n'),
        placements: [
          {
            path: '/databases/{db}/documents/items/{id}',
            operation: 'create',
            bindings: { 'after.size': 'request.resource.data.size' },
          },
        ],
      }),
    );

    const badTplRes = await runEmit([pol, '--no-write', '--firestore-template', badTpl, '--json']);
    expect(badTplRes.code).toBe(POLICY_EXIT_PLACEMENT);
    expect(JSON.parse(badTplRes.out).diagnostics[0].code).toBe('TEMPLATE_COMPOSE_ERROR');

    const bothOut = join(dir, 'both');
    const bothRes = await runEmit([
      pol,
      '--out-dir',
      bothOut,
      '--firestore-template',
      okTpl,
      '--firestore-bindings',
      fsBindings,
      '--json',
    ]);
    expect(bothRes.code).toBe(POLICY_EXIT_OK);
    expect(JSON.parse(bothRes.out).artifacts.map((a: { fileName: string }) => a.fileName)).toEqual([
      'gateWrite.mjs',
      'gateWrite.firestore.rules',
      'gateWrite.firestore.module.rules',
    ]);

    let ioOut = '';
    const writeFailCode = await runPolicy(
      parseArgs(['policy', 'emit', pol, '--out-dir', join(dir, 'ro'), '--json']),
      {
        stdout: { write(s: string) { ioOut += s; } },
        stderr: { write() {} },
        writeFile: (async () => {
          throw new Error('EACCES: permission denied');
        }) as never,
      },
    );
    expect(writeFailCode).toBe(POLICY_EXIT_USAGE);
    const writeFailReport = JSON.parse(ioOut);
    expect(writeFailReport.diagnostics[0].code).toBe('IO_ERROR');
    expect(writeFailReport.diagnostics[0].stage).toBe('io');

    // Mixed-mode Storage split emission via emitStorageModule.
    writeFileSync(
      stMixedPol,
      [
        'use extension bounded;',
        'transition upload {',
        '  require sizeOk { return after.size <= 2048; }',
        '  require tagsOk { return bounded.all(input.tags, t => t != \'\', 4); }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(stBindings, JSON.stringify({ 'after.size': 'request.resource.size' }));
    const stMixedOut = join(dir, 'st-mixed');
    const stMixedRes = await runEmit([
      stMixedPol,
      '--out-dir',
      stMixedOut,
      '--mode',
      'mixed',
      '--storage-bindings',
      stBindings,
      '--json',
    ]);
    expect(stMixedRes.code).toBe(POLICY_EXIT_OK);
    const stReport = JSON.parse(stMixedRes.out) as PolicyEmitReport;
    const stArt = stReport.artifacts.find((a) => a.target === 'storage');
    expect(stArt?.complete).toBe(false);
    expect(stArt?.loweredRequirements).toEqual(['sizeOk']);
    expect(stArt?.residualRequirements).toEqual(['tagsOk']);
  });

  it('keeps lowered/residual disjoint on unverified derive siblings and guards manifest dir before writes', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'sibling.policy');
    const fsFile = join(dir, 'fs.json');
    const stFile = join(dir, 'st.json');
    writeFileSync(
      pol,
      [
        'use extension derive;',
        'transition sib {',
        "  derive { let s = before.size; return {'a': s, 'b': s + 1}; }",
        '  require checkA { return after.size == derived.a; }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(fsFile, JSON.stringify({ 'before.size': 'resource.data.size', 'after.size': 'request.resource.data.size' }));
    writeFileSync(stFile, JSON.stringify({ 'before.size': 'resource.size', 'after.size': 'request.resource.size' }));
    const res = await runEmit([pol, '--no-write', '--mode', 'mixed', '--firestore-bindings', fsFile, '--storage-bindings', stFile, '--json']);
    expect(res.code).toBe(POLICY_EXIT_OK);
    const report = JSON.parse(res.out) as PolicyEmitReport;
    for (const target of ['firestore', 'storage'] as const) {
      const art = report.artifacts.find((a) => a.target === target);
      const summary = report.placement[target]?.summary;
      expect(art?.complete).toBe(false);
      expect(art?.loweredRequirements).toEqual([]);
      expect(art?.residualRequirements).toEqual(['checkA']);
      expect(art?.partialRequirements).toEqual(['checkA']);
      expect(art?.loweredRequirements).toEqual(summary?.loweredRequirements);
      expect(art?.residualRequirements).toEqual(summary?.residualRequirements);
    }

    // Manifest parent under a regular file must fail with IO_ERROR before writing outDir artifacts.
    const blocker = join(dir, 'regular-file');
    const outDir = join(dir, 'never-written');
    writeFileSync(blocker, 'x');
    const badManifest = await runEmit([pol, '--out-dir', outDir, '--manifest', join(blocker, 'manifest.json'), '--json']);
    expect(badManifest.code).toBe(POLICY_EXIT_USAGE);
    expect(JSON.parse(badManifest.out).diagnostics[0].code).toBe('IO_ERROR');
    expect(existsSync(outDir)).toBe(false);
  });
});
