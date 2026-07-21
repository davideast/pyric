#!/usr/bin/env bun
/**
 * Read-only discovery rig for the Storage Rules standard-library boundary.
 *
 * P0 probes source/version/multi-file behavior (12 projects.test requests).
 * P1 runs identical pure function families under Firestore and Storage
 * (14 requests). P2 probes Storage-native MapDiff/update/hash-shaped fields in
 * one 12-case request. Nothing is deployed and no Firebase data is mutated.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectScope } from '../../../packages/pyric/src/project-scope.ts';
import {
  TestFirestoreRulesHandler,
  TestStorageRulesHandler,
} from '../../../packages/pyric/src/rules/test/handler.ts';
import {
  buildApiTestCase,
  buildStorageApiTestCase,
  type StorageTestCase,
} from '../../../packages/pyric/src/rules/test/spec.ts';

type ProbeId = 'p0' | 'p1' | 'p2';
type Engine = 'firestore' | 'storage';
type SourceFile = { name: string; content: string };
type Diagnostic = { notes?: string[]; issues?: unknown[]; httpStatus?: number; error?: unknown; api?: unknown };

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');
const REQUEST_COUNTS: Record<ProbeId, number> = { p0: 12, p1: 14, p2: 1 };

function resolvedFirebaseVersion(): string {
  const path = fileURLToPath(import.meta.resolve('firebase/package.json'));
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

function selectedProbes(args: string[]): ProbeId[] {
  const values = args.flatMap((arg, index) => {
    if (arg === '--probe') return args[index + 1] ? [args[index + 1]] : [];
    return arg.startsWith('--probe=') ? [arg.slice('--probe='.length)] : [];
  });
  if (values.length === 0) return ['p0', 'p1', 'p2'];
  const invalid = values.filter((value) => !['p0', 'p1', 'p2'].includes(value));
  if (invalid.length) throw new Error(`Unknown probe(s): ${invalid.join(', ')}; expected p0, p1, or p2`);
  return [...new Set(values)] as ProbeId[];
}

function printPlan(probes: ProbeId[]): void {
  const total = probes.reduce((sum, probe) => sum + REQUEST_COUNTS[probe], 0);
  console.log('[storage-stdlib:discovery] PARITY_SA_BASE64 not set — INERT preview; no network calls.');
  console.log(`Would run ${total} serial, read-only projects.test request(s):`);
  for (const probe of probes) console.log(`  ${probe}: ${REQUEST_COUNTS[probe]} request(s)`);
}

function observation(
  name: string,
  description: string,
  scope: ProjectScope,
  behavior: Record<string, unknown>,
  diagnostics: Record<string, Diagnostic>,
): Record<string, unknown> {
  return {
    name,
    matrixRow: '',
    rowIds: [],
    description,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId: scope.projectId,
    behavior,
    ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
  };
}

function writeObservation(value: Record<string, unknown>): void {
  mkdirSync(OBS_DIR, { recursive: true });
  const name = value.name as string;
  const path = join(OBS_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote ${path}`);
}

function mainSource(engine: Engine, version: string, prelude: string, condition: string): string {
  if (engine === 'firestore') return `rules_version = '${version}';
${prelude}
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{id} { allow get: if ${condition}; }
  }
}`;
  return `rules_version = '${version}';
${prelude}
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{id} { allow get: if ${condition}; }
  }
}`;
}

function sourceShapes(engine: Engine): Array<{ id: string; files: SourceFile[] }> {
  const main = engine === 'firestore' ? 'firestore.rules' : 'storage.rules';
  const helper = { name: 'shared.rules', content: 'function shared() { return true; }' };
  const exported = { name: 'shared.rules', content: 'export function shared() { return true; }' };
  const importedMain = { name: main, content: mainSource(engine, '2+modules', "import { shared } from 'shared';", 'shared()') };
  return [
    { id: 'single-v2-baseline', files: [{ name: main, content: mainSource(engine, '2', '', 'true') }] },
    { id: 'single-v2-import', files: [{ name: main, content: mainSource(engine, '2', "import { shared } from 'shared';", 'shared()') }] },
    { id: 'single-2plus-import', files: [importedMain] },
    { id: 'multi-v2-no-import', files: [{ name: main, content: mainSource(engine, '2', '', 'shared()') }, helper] },
    { id: 'multi-2plus-import', files: [importedMain, exported] },
    { id: 'multi-2plus-import-reversed', files: [exported, importedMain] },
  ];
}

function p0Case(engine: Engine): unknown {
  const base = { description: 'probe', expectation: 'ALLOW' as const, method: 'get' as const, path: 'probe/x', auth: null, requestTime: '2024-01-01T00:00:00Z' };
  return engine === 'firestore' ? buildApiTestCase(base) : buildStorageApiTestCase(base);
}

async function runP0(scope: ProjectScope): Promise<void> {
  const token = await scope.resolveToken();
  const behavior: Record<string, unknown> = {};
  const diagnostics: Record<string, Diagnostic> = {};
  for (const engine of ['firestore', 'storage'] as const) {
    for (const shape of sourceShapes(engine)) {
      const key = `${engine}: ${shape.id}`;
      const response = await fetch(`https://firebaserules.googleapis.com/v1/projects/${scope.projectId}:test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: { files: shape.files }, testSuite: { testCases: [p0Case(engine)] } }),
      });
      const body = await response.json() as { issues?: unknown[]; testResults?: Array<{ state?: string }>; error?: unknown };
      const state = body.testResults?.[0]?.state;
      behavior[key] = response.status === 400 ? 'INVALID_ARGUMENT' : state === 'SUCCESS' ? 'ALLOW' : body.issues?.length ? 'RULES_ERROR' : 'DENY';
      if (body.issues?.length || body.error || response.status !== 200) {
        diagnostics[key] = { httpStatus: response.status, issues: body.issues, error: body.error };
      }
    }
  }
  writeObservation(observation(
    'stdlib-storage-p0-source-boundaries',
    'Paired Firestore/Storage Rules Test API source-boundary probe: ordinary v2, import syntax under v2 and 2+modules, multi-file linking, and file-order permutations.',
    scope,
    behavior,
    diagnostics,
  ));
}

const P1_FAMILIES: Record<string, readonly string[]> = {
  string: ["'AB'.lower() == 'ab'", "'ab'.upper() == 'AB'", "'  a  '.trim() == 'a'", "'abc'.size() == 3", "'a,b'.split(',').size() == 2", "'ab'.replace('a', 'c') == 'cb'", "'a'.toUtf8().size() >= 1"],
  list: ['[1, 2].hasAll([1])', '[1, 2].hasAny([1])', '[1].hasOnly([1, 2])', '[1, 2].size() == 2', '[1, 2].toSet().size() == 2', '[1].concat([2]).size() == 2', '[1, 2].removeAll([1]).size() == 1', "['a', 'b'].join(',') == 'a,b'"],
  mapSet: ["{'a': 1}.keys().hasAll(['a'])", "{'a': 1}.values().hasAll([1])", "{'a': 1}.size() == 1", "{'a': 1}.get('a', 0) == 1", "{'a': 1}.diff({'a': 1}).affectedKeys().size() == 0", '[1, 2].toSet().difference([1].toSet()).size() == 1', '[1].toSet().union([2].toSet()).size() == 2', '[1, 2].toSet().intersection([2].toSet()).size() == 1'],
  math: ['math.abs(-1) == 1', 'math.ceil(1.2) == 2', 'math.floor(1.8) == 1', 'math.round(1.5) == 2', 'math.sqrt(4) == 2', 'math.pow(2, 3) == 8', 'math.isNaN(0.0) == false'],
  hashing: ["hashing.md5('x').size() >= 0", "hashing.sha256('x').size() >= 0", "hashing.crc32('x').size() >= 0", "hashing.crc32c('x').size() >= 0"],
  valueTypes: ['latlng.value(0.0, 0.0).latitude() == 0.0', "duration.value(1, 's').seconds() == 1", 'duration.time(0, 0, 1, 0).seconds() == 1', "duration.abs(duration.value(-1, 's')).seconds() == 1", 'timestamp.date(2020, 1, 1).year() == 2020', 'timestamp.value(0).toMillis() == 0'],
  invalidMathIsInfinite: ['math.isInfinite(1.0) == false'],
};

function p1Rules(engine: Engine, expressions: readonly string[]): string {
  const condition = expressions.map((expr) => `(${expr})`).join(' && ');
  if (engine === 'firestore') return `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { function portable() { return ${condition}; } match /probe/{id} { allow get: if portable(); } } }`;
  return `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { function portable() { return ${condition}; } match /probe/{id} { allow get: if portable(); } } }`;
}

async function runP1(scope: ProjectScope): Promise<void> {
  const fs = new TestFirestoreRulesHandler();
  const st = new TestStorageRulesHandler();
  const behavior: Record<string, unknown> = {};
  const diagnostics: Record<string, Diagnostic> = {};
  for (const engine of ['firestore', 'storage'] as const) {
    for (const [family, expressions] of Object.entries(P1_FAMILIES)) {
      const key = `${engine}: ${family}`;
      const source = p1Rules(engine, expressions);
      const base = { description: key, expectation: 'ALLOW' as const, method: 'get' as const, path: 'probe/x', auth: null, requestTime: '2024-01-01T00:00:00Z' };
      const result = engine === 'firestore' ? await fs.execute(scope, source, [base]) : await st.execute(scope, source, [base]);
      if (!result.success) {
        behavior[key] = result.error.code;
        diagnostics[key] = { error: result.error };
      } else {
        const item = result.data.results[0];
        behavior[key] = item?.decision ?? 'MISSING_RESULT';
        if (item?.notes.length || result.data.issues?.length) diagnostics[key] = { notes: item?.notes, issues: result.data.issues, api: item?.api };
      }
    }
  }
  writeObservation(observation(
    'stdlib-storage-p1-universal-families',
    'Identical pure Rules function bodies under Firestore and Storage for string, list, Map/MapDiff/Set, math, hashing, duration/timestamp, and LatLng candidates; includes the invalid math.isInfinite control.',
    scope,
    behavior,
    diagnostics,
  ));
}

const P2_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /diff-affected/{id} { allow update: if request.resource.metadata.diff(resource.metadata).affectedKeys().hasOnly(['label']); }
    match /diff-added/{id} { allow update: if request.resource.metadata.diff(resource.metadata).addedKeys().hasOnly(['label']) && request.resource.metadata.diff(resource.metadata).addedKeys().hasAll(['label']); }
    match /diff-removed/{id} { allow update: if request.resource.metadata.diff(resource.metadata).removedKeys().hasOnly(['label']) && request.resource.metadata.diff(resource.metadata).removedKeys().hasAll(['label']); }
    match /updated/{id} { allow get: if resource.updated == timestamp.date(2025, 3, 1) && resource.updated.year() == 2025; }
    match /existing-hashes/{id} { allow get: if resource.md5Hash == 'md5-value' && resource.crc32c == 'crc-value' && resource.etag == 'etag-value'; }
    match /incoming-hashes/{id} { allow create: if request.resource.md5Hash == 'md5-value' && request.resource.crc32c == 'crc-value' && request.resource.etag == 'etag-value'; }
    match /metadata-unicode/{id} { allow create: if request.resource.metadata.label == '雪🚀'; }
  }
}`;

const p2Case = (description: string, value: Omit<StorageTestCase, 'description' | 'expectation'>): StorageTestCase => ({ description, expectation: 'ALLOW', ...value });
const P2_CASES: StorageTestCase[] = [
  p2Case('diff affected: label-only change', { method: 'update', path: 'diff-affected/a', resource: { size: 1, metadata: { owner: 'alice', label: 'new' } }, existingResource: { size: 1, metadata: { owner: 'alice', label: 'old' } } }),
  p2Case('diff affected: owner change is outside allowlist', { method: 'update', path: 'diff-affected/a', resource: { size: 1, metadata: { owner: 'bob', label: 'old' } }, existingResource: { size: 1, metadata: { owner: 'alice', label: 'old' } } }),
  p2Case('diff affected: no-op has empty affected set', { method: 'update', path: 'diff-affected/a', resource: { size: 1, metadata: { owner: 'alice', label: 'old' } }, existingResource: { size: 1, metadata: { owner: 'alice', label: 'old' } } }),
  p2Case('diff added: exactly label', { method: 'update', path: 'diff-added/a', resource: { size: 1, metadata: { owner: 'alice', label: 'new' } }, existingResource: { size: 1, metadata: { owner: 'alice' } } }),
  p2Case('diff added: label plus extra', { method: 'update', path: 'diff-added/a', resource: { size: 1, metadata: { owner: 'alice', label: 'new', extra: 'x' } }, existingResource: { size: 1, metadata: { owner: 'alice' } } }),
  p2Case('diff removed: exactly label', { method: 'update', path: 'diff-removed/a', resource: { size: 1, metadata: { owner: 'alice' } }, existingResource: { size: 1, metadata: { owner: 'alice', label: 'old' } } }),
  p2Case('updated: exact timestamp and accessor', { method: 'get', path: 'updated/a', existingResource: { size: 1, updated: '2025-03-01T00:00:00Z' } }),
  p2Case('updated: missing field', { method: 'get', path: 'updated/a', existingResource: { size: 1 } }),
  p2Case('existing hash fields supplied by test resource', { method: 'get', path: 'existing-hashes/a', existingResource: { size: 1, md5Hash: 'md5-value', crc32c: 'crc-value', etag: 'etag-value' } as never }),
  p2Case('existing hash field absent', { method: 'get', path: 'existing-hashes/a', existingResource: { size: 1 } }),
  p2Case('incoming hash fields supplied by test resource', { method: 'create', path: 'incoming-hashes/a', resource: { size: 1, md5Hash: 'md5-value', crc32c: 'crc-value', etag: 'etag-value' } as never }),
  p2Case('unicode custom metadata equality', { method: 'create', path: 'metadata-unicode/a', resource: { size: 1, metadata: { label: '雪🚀' } } }),
];

async function runP2(scope: ProjectScope): Promise<void> {
  const result = await new TestStorageRulesHandler().execute(scope, P2_RULES, P2_CASES);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  const behavior: Record<string, unknown> = {};
  const diagnostics: Record<string, Diagnostic> = {};
  for (const item of result.data.results) {
    behavior[item.description] = item.decision;
    if (item.notes.length || item.api) diagnostics[item.description] = { notes: item.notes, api: item.api };
  }
  writeObservation(observation(
    'stdlib-storage-p2-native-advanced',
    'Storage Rules Test API discovery for metadata MapDiff boundaries, resource.updated timestamp access, Unicode metadata, and hash-shaped fields explicitly supplied by synthetic fixtures. Hash results prove rule-addressability only, not real-upload population.',
    scope,
    behavior,
    diagnostics,
  ));
}

async function run(): Promise<void> {
  const probes = selectedProbes(Bun.argv.slice(2));
  if (!process.env.PARITY_SA_BASE64) return printPlan(probes);
  const { parityScope } = await import('../../../packages/pyric/test/rules/parity/harness.ts');
  const scope = parityScope();
  for (const probe of probes) {
    console.log(`[storage-stdlib:discovery] running ${probe} (${REQUEST_COUNTS[probe]} request(s))`);
    if (probe === 'p0') await runP0(scope);
    if (probe === 'p1') await runP1(scope);
    if (probe === 'p2') await runP2(scope);
  }
}

if (import.meta.main) await run();
