/**
 * Mirror tests for `src/bridge/surface/firestore-database.ts`: per-database
 * routing across `firestore.*`, `rules.*`, `sandbox.seed` / `exportFixture` /
 * `seedFromFixture` / `inspect`, and CLI `--database <id>`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareFirestoreDatabase, listDeclaredFirestoreDatabases } from 'pyric/firestore/internal';
import { initializeSandbox } from 'pyric/sandbox';

import {
  checkFirestoreDatabase,
  checkRulesFirestoreDatabase,
  firestoreDatabaseSelector,
  onFirestoreDatabase,
} from '../../../src/bridge/surface/firestore-database.js';
import {
  createSurfaceContext,
  renderSurface,
  type OperationResult,
} from '../../../src/bridge/surface/index.js';
import { METHODS } from '../../../src/bridge/surface/methods/registry.js';
import { failFor } from '../../../src/bridge/surface/method-validation.js';
import { parseArgs } from '../../../src/cli/parse-args.js';
import { argumentsFromFlags } from '../../../src/cli/surface-method-args.js';

const DEFAULT_OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

const REPORTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth.uid == 'bob';
    }
  }
}`;

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-surface-fsdb-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function callMethod(
  ctx: ReturnType<typeof createSurfaceContext>,
  surface: ReturnType<typeof renderSurface>,
  key: string,
  args: Record<string, unknown>,
): Promise<OperationResult> {
  const [toolName, methodName] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool || !methodName) throw new Error(`Unknown method ${key}`);
  return tool.execute({ method: methodName, args }, ctx);
}

describe('firestore-database helpers and surface routing', () => {
  it('normalizes selectors, formats summaries, and validates database arguments', () => {
    expect(firestoreDatabaseSelector(undefined)).toBeUndefined();
    expect(firestoreDatabaseSelector('')).toBeUndefined();
    expect(firestoreDatabaseSelector('(default)')).toBeUndefined();
    expect(firestoreDatabaseSelector('reports')).toBe('reports');

    expect(onFirestoreDatabase('Wrote items/a', undefined)).toBe('Wrote items/a');
    expect(onFirestoreDatabase('Wrote items/a', 'reports')).toBe('Wrote items/a on reports');

    const fail = failFor('firestore', 'getDoc');
    expect(checkFirestoreDatabase({}, fail)).toBeNull();
    expect(checkFirestoreDatabase({ database: 'reports' }, fail)).toBeNull();
    expect(checkFirestoreDatabase({ database: '' }, fail)?.ok).toBe(false);

    const rulesFail = failFor('rules', 'set');
    expect(
      checkRulesFirestoreDatabase({ service: 'database', database: 'reports' }, rulesFail)?.ok,
    ).toBe(false);
    expect(
      checkRulesFirestoreDatabase({ service: 'firestore', database: 'BAD_ID' }, rulesFail, 'firestore', true)?.ok,
    ).toBe(false);
    expect(
      checkRulesFirestoreDatabase({ service: 'firestore', database: 'reports' }, rulesFail, 'firestore', true),
    ).toBeNull();
  });

  it('routes firestore data, query, aggregate, discovery, and rules methods per database', async () => {
    const sandbox = initializeSandbox();
    const projectDir = makeProjectDir();
    const ctx = createSurfaceContext(sandbox, projectDir);
    const surface = renderSurface(undefined);

    const missing = await callMethod(ctx, surface, 'firestore.getDoc', {
      path: 'items/shared',
      database: 'undeclared-db',
    });
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain('undeclared-db');

    expect(
      (
        await callMethod(ctx, surface, 'rules.set', {
          service: 'firestore',
          rules: DEFAULT_OPEN_RULES,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await callMethod(ctx, surface, 'rules.set', {
          service: 'firestore',
          database: 'reports',
          rules: REPORTS_RULES,
        })
      ).ok,
    ).toBe(true);
    expect(listDeclaredFirestoreDatabases(sandbox)).toEqual(['reports']);

    await callMethod(ctx, surface, 'firestore.setDoc', {
      path: 'items/shared',
      data: { plane: 'default', amount: 10 },
    });
    const setReports = await callMethod(ctx, surface, 'firestore.setDoc', {
      path: 'items/shared',
      data: { plane: 'reports', amount: 42 },
      database: 'reports',
    });
    expect(setReports.ok).toBe(true);
    expect(setReports.summary).toContain('on reports');

    await callMethod(ctx, surface, 'firestore.addDoc', {
      path: 'items',
      data: { plane: 'reports-auto', amount: 8 },
      database: 'reports',
    });
    await callMethod(ctx, surface, 'firestore.updateDoc', {
      path: 'items/shared',
      data: { updated: true },
      database: 'reports',
    });

    const defaultDoc = await callMethod(ctx, surface, 'firestore.getDoc', {
      path: 'items/shared',
    });
    const reportsDoc = await callMethod(ctx, surface, 'firestore.getDoc', {
      path: 'items/shared',
      database: 'reports',
    });
    expect((defaultDoc.data as { data: Record<string, unknown> }).data).toEqual({
      plane: 'default',
      amount: 10,
    });
    expect((reportsDoc.data as { data: Record<string, unknown> }).data).toEqual({
      plane: 'reports',
      amount: 42,
      updated: true,
    });

    const defaultCount = await callMethod(ctx, surface, 'firestore.getCountFromServer', {
      path: 'items',
    });
    const reportsCount = await callMethod(ctx, surface, 'firestore.getCountFromServer', {
      path: 'items',
      database: 'reports',
    });
    expect((defaultCount.data as { count: number }).count).toBe(1);
    expect((reportsCount.data as { count: number }).count).toBe(2);

    const agg = await callMethod(ctx, surface, 'firestore.getAggregateFromServer', {
      path: 'items',
      spec: { count: true, sum: 'amount' },
      database: 'reports',
    });
    expect(agg.ok).toBe(true);
    expect(agg.data).toEqual({
      count: 2,
      sum: 50,
    });

    await callMethod(ctx, surface, 'firestore.writeBatch', {
      database: 'reports',
      writes: [{ type: 'set', path: 'logs/entry-1', data: { kind: 'audit' } }],
    });

    const discoveredDefault = await callMethod(ctx, surface, 'firestore.discoverPaths', {});
    const discoveredReports = await callMethod(ctx, surface, 'firestore.discoverPaths', {
      database: 'reports',
    });
    expect(JSON.stringify(discoveredDefault.data)).not.toContain('logs');
    expect(JSON.stringify(discoveredReports.data)).toContain('logs');

    const groupReports = await callMethod(ctx, surface, 'firestore.findCollectionGroup', {
      collectionId: 'logs',
      database: 'reports',
    });
    expect(
      (groupReports.data as { hosts: Array<{ path: string }> }).hosts.map((h) => h.path),
    ).toEqual(['logs']);

    const simDefaultBob = await callMethod(ctx, surface, 'rules.simulate', {
      service: 'firestore',
      operation: 'get',
      path: 'items/shared',
      uid: 'bob',
    });
    const simReportsBob = await callMethod(ctx, surface, 'rules.simulate', {
      service: 'firestore',
      database: 'reports',
      operation: 'get',
      path: 'items/shared',
      uid: 'bob',
    });
    expect((simDefaultBob.data as { allowed: boolean }).allowed).toBe(false);
    expect((simReportsBob.data as { allowed: boolean }).allowed).toBe(true);

    const denialReports = await callMethod(ctx, surface, 'rules.explainDenial', {
      service: 'firestore',
      database: 'reports',
      operation: 'get',
      path: 'items/shared',
      uid: 'alice',
    });
    expect(denialReports.ok).toBe(true);
    expect(denialReports.summary).toContain('on reports');

    const inspectedReports = await callMethod(ctx, surface, 'sandbox.inspect', {
      database: 'reports',
      includeData: true,
    });
    expect(inspectedReports.ok).toBe(true);
    expect(inspectedReports.summary).toContain('on reports');
  });

  it('round-trips named databases through sandbox.seed, exportFixture, seedFromFixture, and CLI --database', async () => {
    const sandbox = initializeSandbox();
    const projectDir = makeProjectDir();
    const ctx = createSurfaceContext(sandbox, projectDir);
    const surface = renderSurface(undefined);

    const seeded = await callMethod(ctx, surface, 'sandbox.seed', {
      firestore: { 'items/shared': { db: 'default' } },
      firestoreDatabases: {
        reports: { 'items/shared': { db: 'reports', v: 2 } },
      },
      firestoreDeclared: ['empty-db', 'reports'],
      firestoreRules: {
        '(default)': DEFAULT_OPEN_RULES,
        reports: REPORTS_RULES,
      },
    });
    expect(seeded.ok).toBe(true);
    expect(listDeclaredFirestoreDatabases(sandbox)).toEqual(['empty-db', 'reports']);

    const exported = await callMethod(ctx, surface, 'sandbox.exportFixture', {
      path: 'state.json',
    });
    expect(exported.ok).toBe(true);
    const rawState = JSON.parse(readFileSync(join(projectDir, 'state.json'), 'utf8')) as {
      firestoreDeclared?: string[];
      firestoreDatabases?: Record<string, unknown>;
      firestoreDatabaseRules?: Record<string, string>;
    };
    expect(rawState.firestoreDeclared).toEqual(['empty-db', 'reports']);
    expect(Object.keys(rawState.firestoreDatabases ?? {})).toContain('reports');
    expect(rawState.firestoreDatabaseRules?.reports).toContain("request.auth.uid == 'bob'");

    const restoredSandbox = initializeSandbox();
    const restoredCtx = createSurfaceContext(restoredSandbox, projectDir);
    const loaded = await callMethod(restoredCtx, surface, 'sandbox.seedFromFixture', {
      path: 'state.json',
    });
    expect(loaded.ok).toBe(true);
    expect(listDeclaredFirestoreDatabases(restoredSandbox)).toEqual(['empty-db', 'reports']);

    declareFirestoreDatabase(restoredSandbox, 'cli-db');
    const setRecord = METHODS.find((m) => m.key === 'firestore.setDoc')!;
    const getRecord = METHODS.find((m) => m.key === 'firestore.getDoc')!;
    const setParsed = argumentsFromFlags(
      setRecord,
      parseArgs([
        'firestore',
        'setDoc',
        '--path',
        'items/cli',
        '--data',
        '{"source":"cli"}',
        '--database',
        'cli-db',
      ]),
      projectDir,
    );
    expect('args' in setParsed).toBe(true);
    const setCli = await callMethod(
      restoredCtx,
      surface,
      'firestore.setDoc',
      (setParsed as { args: Record<string, unknown> }).args,
    );
    expect(setCli.ok).toBe(true);

    const getParsed = argumentsFromFlags(
      getRecord,
      parseArgs(['firestore', 'getDoc', '--path', 'items/cli', '--database', 'cli-db']),
      projectDir,
    );
    expect('args' in getParsed).toBe(true);
    const getCli = await callMethod(
      restoredCtx,
      surface,
      'firestore.getDoc',
      (getParsed as { args: Record<string, unknown> }).args,
    );
    expect(getCli.ok).toBe(true);
    expect((getCli.data as { data: Record<string, unknown> }).data).toEqual({ source: 'cli' });
  });
});
