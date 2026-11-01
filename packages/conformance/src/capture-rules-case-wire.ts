#!/usr/bin/env bun
/**
 * Capture how production's Firestore Rules Test API reads a case's documents
 * (#1338).
 *
 * Every probe submits one ruleset and raw Rules Test API cases to
 * `projects.test`, which evaluates them without deploying anything. The cases
 * are sent as written, not through `buildApiTestCase`, because two of the
 * probes send what pyric now refuses or sends differently:
 *   - `create-with-resource` (FS2-CON-12): a create case that names an
 *     existing resource. Production binds it, so pyric refuses the case.
 *   - `tagged-map` (FS2-CON-5): a plain map shaped like pyric's old
 *     `{__type: 'timestamp'}` encoding. Production reads it as a map.
 *   - `wire-forms`: the JSON forms production reads as a timestamp, latlng,
 *     duration and path, which `buildApiTestCase` sends for the value helpers,
 *     and a base64 string, which stays a string, so bytes have no form.
 *   - `string-sniffing`: plain strings and maps the Rules Test API reads as
 *     typed values, so a case can't send them as the string or map they are.
 *
 * Output: packages/pyric/test/rules/test/fixtures/case-wire/captures.json
 *
 * Credentials: the same contract as `capture-rules-compile-limits.ts`.
 *
 * Usage:
 *   PARITY_PROJECT_ID=<project> bun run packages/conformance/src/capture-rules-case-wire.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './rules-expression-cost-suites.ts';

const RULES_API = 'https://firebaserules.googleapis.com/v1';
const OUT_DIR = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'test', 'fixtures', 'case-wire');
const OUT = join(OUT_DIR, 'captures.json');
const DOCS = '/databases/(default)/documents';

function ruleset(blocks: string[]): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${blocks.map((b) => `    ${b}`).join('\n')}\n  }\n}\n`;
}

/** One wire case: a create of `<collection>/d1` by uid alice. */
interface WireCase {
  description: string;
  collection: string;
  data?: Record<string, unknown>;
  resource?: Record<string, unknown>;
}

interface Probe { rules: string; cases: WireCase[] }

const AT = { __type: 'timestamp', seconds: 1767225600, nanos: 0 };

/** `is <type>` for `request.resource.data.v`, one block per type. */
const TYPE_BLOCKS = ['timestamp', 'latlng', 'duration', 'path', 'bytes', 'string', 'map'].map(
  (type) => `match /is-${type}/{id} { allow create: if request.resource.data.v is ${type}; }`,
);

function typeCases(label: string, v: unknown, types: string[]): WireCase[] {
  return types.map((type) => ({ description: `${label} is ${type}`, collection: `is-${type}`, data: { v } }));
}

export const PROBES: Record<string, Probe> = {
  'create-with-resource': {
    rules: ruleset([
      'match /createResData/{id} { allow create: if resource.data.x == 1; }',
      'match /createResNull/{id} { allow create: if resource == null; }',
      'match /createResNotNull/{id} { allow create: if resource != null; }',
    ]),
    cases: [
      { description: 'create with resource: resource.data.x == 1', collection: 'createResData', data: { x: 2 }, resource: { x: 1 } },
      { description: 'create with resource: resource == null', collection: 'createResNull', data: { x: 2 }, resource: { x: 1 } },
      { description: 'create with resource: resource != null', collection: 'createResNotNull', data: { x: 2 }, resource: { x: 1 } },
      { description: 'create without resource: resource.data.x == 1', collection: 'createResData', data: { x: 2 } },
      { description: 'create without resource: resource == null', collection: 'createResNull', data: { x: 2 } },
    ],
  },
  'tagged-map': {
    rules: ruleset(TYPE_BLOCKS),
    cases: typeCases('{__type: timestamp} map', AT, ['timestamp', 'map']),
  },
  'wire-forms': {
    rules: ruleset([
      ...TYPE_BLOCKS,
      "match /ts-parts/{id} { allow create: if request.resource.data.v == timestamp.date(2026, 1, 1) + duration.value(123, 'ms'); }",
      'match /latlng-parts/{id} { allow create: if request.resource.data.v.latitude() == 1.5 && request.resource.data.v.longitude() == -2; }',
      "match /duration-parts/{id} { allow create: if request.resource.data.v == duration.value(-1500, 'ms'); }",
      `match /path-parts/{id} { allow create: if request.resource.data.v == ${DOCS}/users/alice; }`,
    ]),
    cases: [
      ...typeCases('timestamp form', '2026-01-01T00:00:00.123000000Z', ['timestamp', 'string']),
      { description: 'timestamp form keeps the instant', collection: 'ts-parts', data: { v: '2026-01-01T00:00:00.123000000Z' } },
      ...typeCases('latlng form', { latitude: 1.5, longitude: -2 }, ['latlng', 'map']),
      { description: 'latlng form keeps the point', collection: 'latlng-parts', data: { v: { latitude: 1.5, longitude: -2 } } },
      ...typeCases('duration form', '-1.500000000s', ['duration', 'string']),
      { description: 'duration form keeps the length', collection: 'duration-parts', data: { v: '-1.500000000s' } },
      ...typeCases('reference form', `${DOCS}/users/alice`, ['path', 'string']),
      { description: 'reference form keeps the path', collection: 'path-parts', data: { v: `${DOCS}/users/alice` } },
      ...typeCases('base64 string', 'aGk=', ['bytes', 'string']),
    ],
  },
  'string-sniffing': {
    rules: ruleset(TYPE_BLOCKS),
    cases: [
      ...typeCases('ISO string with offset', '2026-01-01T00:00:00+02:00', ['string', 'timestamp']),
      ...typeCases('ISO string without offset', '2026-01-01T00:00:00', ['string', 'timestamp']),
      ...typeCases('seconds string', '5s', ['string', 'duration']),
      ...typeCases('slash string', '/a/b', ['string', 'path']),
      ...typeCases('latitude and longitude map', { latitude: 1, longitude: 2 }, ['map', 'latlng']),
      ...typeCases('latitude and longitude map with another key', { latitude: 1, longitude: 2, x: 1 }, ['map', 'latlng']),
    ],
  },
};

/** The raw Rules Test API case each probe case sends. */
export function wireCase(c: WireCase): Record<string, unknown> {
  return {
    expectation: 'ALLOW',
    request: {
      auth: { uid: 'alice', token: {} },
      method: 'create',
      path: `${DOCS}/${c.collection}/d1`,
      ...(c.data ? { resource: { data: c.data } } : {}),
    },
    ...(c.resource ? { resource: { data: c.resource } } : {}),
  };
}

interface CaseRecord { description: string; wire: Record<string, unknown>; decision: 'ALLOW' | 'DENY'; notes: string[] }

async function main(): Promise<void> {
  const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
  const scope = parityScope();
  const probes: Record<string, { rules: string; cases: CaseRecord[] }> = {};
  let calls = 0;
  for (const [name, probe] of Object.entries(PROBES)) {
    const testCases = probe.cases.map(wireCase);
    const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await scope.resolveToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: probe.rules }] }, testSuite: { testCases } }),
    });
    calls++;
    if (!res.ok) throw new Error(`Rules Test API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { testResults?: Array<{ state: string; debugMessages?: string[] }> };
    const results = data.testResults ?? [];
    if (results.length !== testCases.length) throw new Error(`${name}: ${results.length} results for ${testCases.length} cases`);
    probes[name] = {
      rules: probe.rules,
      cases: probe.cases.map((c, i) => ({
        description: c.description,
        wire: testCases[i]!,
        decision: results[i]!.state === 'SUCCESS' ? 'ALLOW' : 'DENY',
        notes: results[i]!.debugMessages ?? [],
      })),
    };
    console.log(`  ${name.padEnd(24)} ${probes[name]!.cases.map((c) => `${c.description}=${c.decision}`).join('; ')}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const fixture = {
    schema: 'pyric.rules-case-wire.v1',
    capturedAt: new Date().toISOString(),
    projectId: scope.projectId,
    method: 'Rules Test API projects.test, one ruleset per probe from PROBES in packages/conformance/src/capture-rules-case-wire.ts; every case is a create of <collection>/d1 by uid alice with expectation ALLOW, so SUCCESS is ALLOW and FAILURE is DENY.',
    calls,
    probes,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[case-wire] ${calls} Rules Test API calls; wrote ${OUT}`);
}

if (import.meta.main) {
  await main();
}
