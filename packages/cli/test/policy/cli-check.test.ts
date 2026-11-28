import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_STATIC,
  POLICY_EXIT_USAGE,
  runPolicy,
  type PolicyCheckReport,
} from '../../src/cli/policy/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-check-'));
  tempDirs.push(dir);
  return dir;
}

async function runCheck(argv: string[]) {
  let out = '';
  let err = '';
  const code = await runPolicy(parseArgs(['policy', 'check', ...argv]), {
    stdout: { write(s: string) { out += s; } },
    stderr: { write(s: string) { err += s; } },
  });
  return { code, out, err };
}

const COUNTER_POLICY = `transition nextStep {
  require increment {
    return before.count is int
      && before.count >= 0
      && before.count <= 9007199254740991
      && after.count is int
      && after.count >= 0
      && after.count <= 9007199254740991
      && after.count == before.count + 1;
  }
}
`;

const SPLIT_POLICY = `use extension derive;
use extension bounded;

transition checkout {
  derive {
    let itemTotal = bounded.fold(input.items, 0, (acc, item) => acc + item.price, 8);
    return {'total': itemTotal};
  }
  require ownerPreserved {
    return after.owner == before.owner;
  }
  require totalMatches {
    return after.total == derived.total;
  }
}
`;

const STORAGE_POLICY = `transition uploadAvatar {
  require sizeCeiling {
    return after.size <= 1048576;
  }
  require mimeAllowed {
    return after.contentType == 'image/png' || after.contentType == 'image/jpeg';
  }
}
`;

describe('pyric policy check', () => {
  it('verifies complete lowering across Firestore and RTDB with uniform JSON reports', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'counter.policy');
    const fsBindings = join(dir, 'fs.json');
    const rtdbBindings = join(dir, 'rtdb.json');
    writeFileSync(pol, COUNTER_POLICY);
    writeFileSync(
      fsBindings,
      JSON.stringify({
        'before.count': 'resource.data.count',
        'after.count': 'request.resource.data.count',
      }),
    );
    writeFileSync(
      rtdbBindings,
      JSON.stringify({
        'before.count': { snapshot: 'data', path: 'count', type: 'number' },
        'after.count': { snapshot: 'newData', path: 'count', type: 'number' },
      }),
    );

    const res = await runCheck([
      pol,
      '--firestore-bindings',
      fsBindings,
      '--rtdb-bindings',
      rtdbBindings,
      '--mode',
      'complete',
      '--json',
    ]);
    expect(res.code).toBe(POLICY_EXIT_OK);
    expect(res.err).toBe('');
    const report = JSON.parse(res.out) as PolicyCheckReport;
    expect(report.schema).toBe('pyric.policy.check.v1');
    expect(report.ok).toBe(true);
    expect(report.kind).toBe('transition');
    expect(report.staticCheck.ok).toBe(true);
    expect(report.staticCheck.transitionName).toBe('nextStep');
    expect(report.staticCheck.requirements).toEqual(['increment']);
    expect(report.standalone.ok).toBe(true);
    expect(report.standalone.exports).toEqual(['judge']);
    expect(report.standalone.moduleBytes).toBeGreaterThan(0);

    expect(report.placement.firestore?.complete).toBe(true);
    expect(report.placement.firestore?.summary).toEqual({
      total: 1,
      lowered: 1,
      residual: 0,
      loweredRequirements: ['increment'],
      residualRequirements: [],
    });
    expect(report.placement.firestore?.rows[0]?.diagnostics[0]?.code).toBe('LOWERED');
    expect(report.placement.firestore?.rows[0]?.span.line).toBe(2);
    expect(report.placement.rtdb?.complete).toBe(true);
    expect(report.placement.rtdb?.rows[0]?.predicate).toBeDefined();
    expect(report.cost.totalSourceUnits).toBeGreaterThan(0);
    expect(report.cost.withinSourceBudget).toBe(true);
    expect(report.cost.byTarget.firestore?.totalTargetUnits).toBeGreaterThan(0);
  });

  it('reports placement splits in mixed mode and exits 3 in complete mode', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'checkout.policy');
    const fsBindings = join(dir, 'fs.json');
    writeFileSync(pol, SPLIT_POLICY);
    writeFileSync(
      fsBindings,
      JSON.stringify({
        'before.owner': 'resource.data.owner',
        'after.owner': 'request.resource.data.owner',
        'after.total': 'request.resource.data.total',
      }),
    );

    const mixed = await runCheck([pol, '--firestore-bindings', fsBindings, '--json']);
    expect(mixed.code).toBe(POLICY_EXIT_OK);
    const mixedReport = JSON.parse(mixed.out) as PolicyCheckReport;
    expect(mixedReport.mode).toBe('mixed');
    expect(mixedReport.placement.firestore?.complete).toBe(false);
    expect(mixedReport.placement.firestore?.summary).toEqual({
      total: 2,
      lowered: 1,
      residual: 1,
      loweredRequirements: ['ownerPreserved'],
      residualRequirements: ['totalMatches'],
    });
    const residualRow = mixedReport.placement.firestore?.rows.find((r) => r.requirement === 'totalMatches');
    expect(residualRow?.lowered).toBe(false);
    expect(residualRow?.diagnostics[0]?.code).toBe('USES_BOUNDED_OP');

    const complete = await runCheck([
      pol,
      '--firestore-bindings',
      fsBindings,
      '--mode',
      'complete',
      '--json',
    ]);
    expect(complete.code).toBe(POLICY_EXIT_PLACEMENT);
    const completeReport = JSON.parse(complete.out) as PolicyCheckReport;
    expect(completeReport.ok).toBe(false);
    expect(completeReport.exitCode).toBe(3);
    expect(completeReport.diagnostics[0]?.code).toBe('TARGET_LOWERING_ERROR');
    expect(completeReport.diagnostics[0]?.target).toBe('firestore');
    expect(completeReport.diagnostics[0]?.requirement).toBe('totalMatches');
    expect(completeReport.diagnostics[0]?.span?.line).toBe(12);
  });

  it('requires at least one target binding file when --mode complete is set on a transition', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'counter.policy');
    writeFileSync(pol, COUNTER_POLICY);
    const res = await runCheck([pol, '--mode', 'complete', '--json']);
    expect(res.code).toBe(POLICY_EXIT_USAGE);
    const report = JSON.parse(res.out) as PolicyCheckReport;
    expect(report.diagnostics[0]?.code).toBe('USAGE_ERROR');
  });

  it('classifies Storage bindings cleanly including lowered, missing, and wrong origin', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'avatar.policy');
    const okBindings = join(dir, 'ok.json');
    const badBindings = join(dir, 'bad.json');
    writeFileSync(pol, STORAGE_POLICY);
    writeFileSync(
      okBindings,
      JSON.stringify({
        'after.size': 'request.resource.size',
        'after.contentType': 'request.resource.contentType',
      }),
    );
    writeFileSync(
      badBindings,
      JSON.stringify({
        'after.size': 'resource.size',
      }),
    );

    const good = await runCheck([pol, '--storage-bindings', okBindings, '--mode', 'complete', '--json']);
    expect(good.code).toBe(POLICY_EXIT_OK);
    const goodReport = JSON.parse(good.out) as PolicyCheckReport;
    expect(goodReport.placement.storage?.complete).toBe(true);
    expect(goodReport.placement.storage?.rows[0]?.cost.sourceUnits).toBeGreaterThan(0);

    const bad = await runCheck([pol, '--storage-bindings', badBindings, '--mode', 'complete', '--json']);
    expect(bad.code).toBe(POLICY_EXIT_PLACEMENT);
    const badReport = JSON.parse(bad.out) as PolicyCheckReport;
    const sizeRow = badReport.placement.storage?.rows.find((r) => r.requirement === 'sizeCeiling');
    const mimeRow = badReport.placement.storage?.rows.find((r) => r.requirement === 'mimeAllowed');
    expect(sizeRow?.diagnostics.some((d) => d.code === 'WRONG_SNAPSHOT_ORIGIN')).toBe(true);
    expect(mimeRow?.diagnostics.some((d) => d.code === 'MISSING_BINDING')).toBe(true);
  });

  it('checks function and bounded module dialects accurately', async () => {
    const dir = makeTempDir();
    const fnFile = join(dir, 'add.policy');
    writeFileSync(fnFile, 'function isAdult(age) {\n  return age >= 18;\n}\n');
    const rtdbFile = join(dir, 'fn-rtdb.json');
    writeFileSync(rtdbFile, JSON.stringify({ age: { snapshot: 'newData', path: 'age', type: 'number' } }));

    const fnRes = await runCheck([fnFile, '--rtdb-bindings', rtdbFile, '--mode', 'complete', '--json']);
    expect(fnRes.code).toBe(POLICY_EXIT_OK);
    const fnReport = JSON.parse(fnRes.out) as PolicyCheckReport;
    expect(fnReport.kind).toBe('function');
    expect(fnReport.placement.functions?.[0]?.firestoreLowerable).toBe(true);
    expect(fnReport.placement.functions?.[0]?.rtdbLowerable).toBe(true);

    const modFile = join(dir, 'scores.policy');
    writeFileSync(
      modFile,
      [
        'use extension bounded;',
        'export function sumCents(items) {',
        '  return bounded.fold(items, 0, (acc, x) => acc + x, 16);',
        '}',
        '',
      ].join('\n'),
    );
    const modRes = await runCheck([modFile, '--json']);
    expect(modRes.code).toBe(POLICY_EXIT_OK);
    const modReport = JSON.parse(modRes.out) as PolicyCheckReport;
    expect(modReport.kind).toBe('module');
    expect(modReport.staticCheck.exports).toEqual(['sumCents']);
    expect(modReport.cost.boundedOps).toHaveLength(1);
    expect(modReport.cost.boundedOps[0]?.op).toBe('bounded.fold');
    expect(modReport.cost.boundedOps[0]?.limit).toBe(16);

    const modComplete = await runCheck([modFile, '--mode', 'complete', '--json']);
    expect(modComplete.code).toBe(POLICY_EXIT_PLACEMENT);
  });

  it('extracts structured spans and error codes for syntax and static errors', async () => {
    const dir = makeTempDir();

    const syntaxFile = join(dir, 'syntax.policy');
    writeFileSync(
      syntaxFile,
      ['transition broken {', '  require ok {', '    return after.x == 1', '  }', '}', ''].join('\n'),
    );
    const synRes = await runCheck([syntaxFile, '--json']);
    expect(synRes.code).toBe(POLICY_EXIT_STATIC);
    const synReport = JSON.parse(synRes.out) as PolicyCheckReport;
    expect(synReport.diagnostics[0]?.code).toBe('SYNTAX_ERROR');
    expect(synReport.diagnostics[0]?.stage).toBe('parse');
    expect(synReport.diagnostics[0]?.span?.line).toBeGreaterThanOrEqual(3);
    expect(synReport.diagnostics[0]?.span?.excerpt).toBeDefined();

    const missingExt = join(dir, 'missing-ext.policy');
    writeFileSync(
      missingExt,
      [
        'transition t {',
        '  derive {',
        "    return {'x': 1};",
        '  }',
        '  require r {',
        '    return after.x == derived.x;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const extRes = await runCheck([missingExt, '--json']);
    expect(extRes.code).toBe(POLICY_EXIT_STATIC);
    const extReport = JSON.parse(extRes.out) as PolicyCheckReport;
    expect(extReport.diagnostics[0]?.code).toBe('MISSING_EXTENSION');
    expect(extReport.diagnostics[0]?.span?.line).toBe(2);
    expect(extReport.diagnostics[0]?.span?.inferred).toBe(true);

    const cycleFile = join(dir, 'cycle.policy');
    writeFileSync(
      cycleFile,
      [
        'use extension bounded;',
        'function a(x) { return b(x); }',
        'export function b(x) { return a(x); }',
        '',
      ].join('\n'),
    );
    const cycRes = await runCheck([cycleFile, '--json']);
    expect(cycRes.code).toBe(POLICY_EXIT_STATIC);
    const cycReport = JSON.parse(cycRes.out) as PolicyCheckReport;
    expect(cycReport.diagnostics[0]?.code).toBe('RECURSIVE_CALL');
    expect(cycReport.diagnostics[0]?.span?.line).toBe(2);

    const undefFile = join(dir, 'undef.policy');
    writeFileSync(
      undefFile,
      ['transition t {', '  require badRef {', '    return missingVar == 1;', '  }', '}', ''].join('\n'),
    );
    const undefRes = await runCheck([undefFile, '--json']);
    expect(undefRes.code).toBe(POLICY_EXIT_STATIC);
    const undefReport = JSON.parse(undefRes.out) as PolicyCheckReport;
    expect(undefReport.diagnostics[0]?.requirement).toBe('badRef');
    expect(undefReport.diagnostics[0]?.span?.line).toBe(2);

    const dupFile = join(dir, 'dup.policy');
    writeFileSync(
      dupFile,
      [
        'use extension bounded;',
        'export function f(x) { return x; }',
        'export function f(x) { return x + 1; }',
        '',
      ].join('\n'),
    );
    const dupRes = await runCheck([dupFile, '--json']);
    expect(dupRes.code).toBe(POLICY_EXIT_STATIC);
    expect(JSON.parse(dupRes.out).diagnostics[0].code).toBe('DUPLICATE_DECLARATION');
    expect(JSON.parse(dupRes.out).diagnostics[0].span.line).toBe(3);

    const bigIntFile = join(dir, 'bigint.policy');
    writeFileSync(bigIntFile, 'transition t { require r { return after.x == 99999999999999999999999; } }\n');
    const bigRes = await runCheck([bigIntFile, '--json']);
    expect(bigRes.code).toBe(POLICY_EXIT_STATIC);
    expect(JSON.parse(bigRes.out).diagnostics[0].code).toBe('INVALID_LITERAL');

    const overLimit = await runCheck([
      join(dir, 'counter-limit.policy'),
      '--expression-limit',
      '50000',
      '--json',
    ]).catch(() => null);
    expect(overLimit?.code).toBe(POLICY_EXIT_USAGE); // file does not exist yet
    writeFileSync(join(dir, 'counter-limit.policy'), COUNTER_POLICY);
    const limitRes = await runCheck([
      join(dir, 'counter-limit.policy'),
      '--expression-limit',
      '50000',
      '--json',
    ]);
    expect(limitRes.code).toBe(POLICY_EXIT_STATIC);
    expect(JSON.parse(limitRes.out).diagnostics[0].code).toBe('EXPRESSION_LIMIT_ERROR');
  });

  it('loads --config relative bindings, allows CLI override, and renders ASCII text output', async () => {
    const dir = makeTempDir();
    const pol = join(dir, 'counter.policy');
    const cfg = join(dir, 'policy.json');
    const fsPath = join(dir, 'bindings.json');
    writeFileSync(pol, COUNTER_POLICY);
    writeFileSync(
      fsPath,
      JSON.stringify({
        'before.count': 'resource.data.count',
        'after.count': 'request.resource.data.count',
      }),
    );
    writeFileSync(
      cfg,
      JSON.stringify({
        mode: 'complete',
        firestore: { bindingsFile: './bindings.json' },
      }),
    );

    const res = await runCheck([pol, '--config', cfg]);
    expect(res.code).toBe(POLICY_EXIT_OK);
    expect(res.out).toContain('pyric policy check: OK');
    expect(res.out).toContain('firestore: 1/1 lowered (complete)');
    expect(/^[\x00-\x7f]*$/.test(res.out)).toBe(true);

    const override = await runCheck([pol, '--config', cfg, '--mode', 'mixed', '--json']);
    expect(override.code).toBe(POLICY_EXIT_OK);
    expect(JSON.parse(override.out).mode).toBe('mixed');
  });
});
