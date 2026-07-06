#!/usr/bin/env bun
/**
 * Smoke test for `createSandboxCrawlerFirestore` + `createDiscoverTools`.
 *
 * Drives the adapter end-to-end with a synthetic snapshot (the same
 * `Record<path, data>` shape `SandboxRunner.readState()` returns)
 * and prints the schemas the crawler emits. Pass condition: at least
 * one templatePath is finalized with field count > 0 for each top
 * level collection in the fixture.
 *
 * Run: bun run examples/playground-next/scripts/smoke-sandbox-discover.ts
 *
 * Exit 0 = adapter wires up; exit 1 = empty schemas (regression).
 */
import { createSandboxCrawlerFirestore } from '../src/lib/sandbox/crawler-firestore.ts';
import { trimDiscoverResult } from '../src/lib/tools/diagnostics/firestore-discover.ts';
import { createFirestoreDiscoverTools } from 'pyric-tools/discover';

// `gameConfig` mimics the production failure mode: a config doc that
// uses a map as a dictionary (a move table keyed by hundreds of
// coordinates). Without the trim's map-collapse, every key becomes a
// nested field descriptor and the result balloons.
const bigMoveTable: Record<string, unknown> = {};
for (let i = 0; i < 400; i++) bigMoveTable[`c${i % 8}r${Math.floor(i / 8)}_${i}`] = { slide: true, jump: false };

const snapshot: Record<string, unknown> = {
  'users/alice': { name: 'Alice', age: 30, active: true, joinedAt: { seconds: 1700000000, nanoseconds: 0 } },
  'users/bob': { name: 'Bob', age: 25, active: false, joinedAt: { seconds: 1701000000, nanoseconds: 0 } },
  'users/alice/posts/p1': { title: 'first', tags: ['hi', 'world'] },
  'users/alice/posts/p2': { title: 'second', tags: ['foo'] },
  'rooms/r1': { name: 'lobby' },
  'gameConfig/checkers': { version: '1.0', moves: bigMoveTable },
};

const crawlerDb = createSandboxCrawlerFirestore(() => snapshot);
const tools = createFirestoreDiscoverTools({ resolveDb: () => crawlerDb as never });
const discover = tools.find((t) => t.name === 'firestore_discover_paths')!;

console.log('Calling firestore_discover_paths against sandbox snapshot…');
const result = await discover.execute({}, { signal: new AbortController().signal });
if (!result.ok) {
  console.error('FAIL · tool returned error:', result.summary);
  process.exit(1);
}

const data = result.data as { schemas: Record<string, { schema: { fields: Record<string, unknown>; samplesSeen: number } }>; listOps: number; readOps: number };
const templates = Object.keys(data.schemas);
console.log(`templatePaths: [${templates.join(', ')}]`);
console.log(`listOps=${data.listOps} readOps=${data.readOps}`);

let failures = 0;
for (const tp of templates) {
  const s = data.schemas[tp];
  const fields = Object.keys(s?.schema?.fields ?? {});
  console.log(`  - ${tp}: ${fields.length} field(s) · samples=${s?.schema?.samplesSeen ?? 0} · [${fields.join(', ')}]`);
  if (fields.length === 0) {
    failures++;
    console.error(`    FAIL · ${tp} has zero fields`);
  }
}

const expected = ['users', 'rooms', 'users/{userId}/posts', 'gameConfig'];
for (const e of expected) {
  if (!templates.includes(e)) {
    failures++;
    console.error(`FAIL · expected templatePath "${e}" not in schemas`);
  }
}

// ─── Verify the trim collapses the high-cardinality nested map ───────────
console.log('\nApplying trimDiscoverResult…');
const rawJson = JSON.stringify(result.data);
const trimmed = trimDiscoverResult(result.data) as {
  schemas: Record<string, { schema: { fields: Record<string, unknown> } }>;
  eventCount: number;
};
const trimmedJson = JSON.stringify(trimmed);
console.log(`  raw result: ${rawJson.length} chars · trimmed: ${trimmedJson.length} chars · eventCount=${trimmed.eventCount}`);

const movesField = trimmed.schemas['gameConfig']?.schema?.fields?.['moves'] as
  | { types?: Array<{ kind?: string; collapsed?: boolean; keyCount?: number; sampleKeys?: string[] }> }
  | undefined;
const mapType = movesField?.types?.find((t) => t.kind === 'map');
if (!mapType) {
  failures++;
  console.error('FAIL · gameConfig.moves has no map type after trim');
} else if (!mapType.collapsed) {
  failures++;
  console.error(`FAIL · gameConfig.moves map was NOT collapsed (still has ${Object.keys((mapType as { fields?: object }).fields ?? {}).length} fields)`);
} else {
  console.log(`  gameConfig.moves collapsed: keyCount=${mapType.keyCount} sampleKeys=[${mapType.sampleKeys?.join(', ')}]`);
  if (trimmedJson.length >= rawJson.length) {
    failures++;
    console.error('FAIL · trimmed result is not smaller than raw');
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nOK · sandbox-backed discover wired up end-to-end + trim collapses big maps.');
