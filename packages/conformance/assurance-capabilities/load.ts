/**
 * Assurance-capability record loader.
 *
 * `assurance-capabilities/` is the index: one authored `AssuranceCapabilityRecord`
 * per capability, in `<capability-id>.ts`, exporting `capability`. The filename
 * IS the id; the record carries no id field (the `exceptions/` convention).
 * Adding a capability is adding a file; the directory is the list.
 *
 * Loading is synchronous (Bun's `require` handles `.ts`), the same technique
 * `surfaces/load.ts` and `exceptions/load.ts` use.
 *
 * The loader validates SHAPE only (a record exists, is well-formed, declares at
 * least one dependency). Whether a declared dependency resolves in the
 * conformance graph is the derivation's job — see `src/assurance-capabilities.ts`.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AssuranceCapabilityRecord,
  AssuranceCapabilityService,
  CapabilityDependency,
} from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['load.ts', 'types.ts', 'generated.ts']);

const SERVICES = new Set<string>(['firestore', 'rtdb', 'storage', 'auth']);

/** One loaded record, with the id the filename supplied. */
export interface LoadedCapability extends AssuranceCapabilityRecord {
  id: string;
}

function dependencyProblems(id: string, index: number, dep: unknown): string[] {
  const at = `${id}.ts dependencies[${index}]`;
  if (typeof dep !== 'object' || dep === null) return [`${at}: not an object`];
  const d = dep as Partial<CapabilityDependency> & { id?: unknown; behavior?: unknown; reason?: unknown };
  if (d.kind === 'construct' || d.kind === 'registry-row') {
    if (typeof d.id !== 'string' || d.id.length === 0) return [`${at}: ${d.kind} dependency missing id`];
    return [];
  }
  if (d.kind === 'unbacked') {
    const problems: string[] = [];
    if (typeof d.behavior !== 'string' || d.behavior.length === 0) problems.push(`${at}: unbacked dependency missing behavior`);
    if (typeof d.reason !== 'string' || d.reason.length === 0) problems.push(`${at}: unbacked dependency missing reason`);
    return problems;
  }
  return [`${at}: illegal kind "${String((d as { kind?: unknown }).kind)}"`];
}

/** Structural problems in one record (empty = valid). */
export function capabilityRecordProblems(id: string, record: unknown): string[] {
  if (typeof record !== 'object' || record === null) return [`${id}.ts: does not export a 'capability' record`];
  const r = record as Partial<AssuranceCapabilityRecord> & { id?: unknown; status?: unknown };
  const problems: string[] = [];
  if (r.id !== undefined) problems.push(`${id}.ts: record carries an 'id' field; the filename is the id`);
  if (r.status !== undefined) {
    problems.push(`${id}.ts: record carries a 'status' field; status is DERIVED from the conformance graph, never authored`);
  }
  if (typeof r.service !== 'string' || !SERVICES.has(r.service)) {
    problems.push(`${id}.ts: illegal service "${String(r.service)}"`);
  } else if (!id.startsWith(`${r.service}.`)) {
    problems.push(`${id}.ts: id must be prefixed with its service ("${r.service}.")`);
  }
  if (typeof r.description !== 'string' || r.description.trim().length === 0) {
    problems.push(`${id}.ts: missing description`);
  }
  if (!Array.isArray(r.dependencies) || r.dependencies.length === 0) {
    problems.push(`${id}.ts: a capability must declare at least one dependency`);
    return problems;
  }
  for (const [index, dep] of r.dependencies.entries()) {
    problems.push(...dependencyProblems(id, index, dep));
  }
  return problems;
}

/** Reads every `<capability-id>.ts` in this directory. Throws on any structural
 *  problem — a malformed record is a hard failure, not a skipped file. */
export function loadAssuranceCapabilityRecords(): LoadedCapability[] {
  const files = readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !NON_RECORD_FILES.has(f))
    .sort();
  const loaded: LoadedCapability[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = require(join(HERE, file)) as { capability?: unknown };
    const found = capabilityRecordProblems(id, mod.capability);
    if (found.length > 0) {
      problems.push(...found);
      continue;
    }
    loaded.push({ id, ...(mod.capability as AssuranceCapabilityRecord) });
  }
  if (problems.length > 0) {
    throw new Error(`Invalid assurance-capability records:\n  - ${problems.join('\n  - ')}`);
  }
  return loaded;
}

export type { AssuranceCapabilityRecord, AssuranceCapabilityService, CapabilityDependency };
