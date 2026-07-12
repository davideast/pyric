/**
 * Rig manifest loader.
 *
 * `scripts/oracle/rigs/` is the index: one authored `RigManifestRecord` per
 * file, named `<rig-id>.ts`. There is no hand-maintained barrel/list — this
 * loader reads the directory, dynamic-imports every rig file, derives each
 * rig's id from its filename, and returns the typed array. Adding a rig is
 * adding a file; removing one is deleting a file. This mirrors the
 * one-record-per-file convention `scripts/oracle/observations/` already uses,
 * so both directories stay conflict-free under parallel edits and browsable
 * as inventories.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RigAutomation, RigManifest, RigManifestRecord } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_FILE = 'load.ts';
const TYPES_FILE = 'types.ts';

const AUTOMATION_VALUES = new Set<RigAutomation>(['unattended', 'credentialed', 'human-witnessed']);
const NETWORK_VALUES = new Set(['none', 'firebase-production']);
const VERSION_FIELD_VALUES = new Set(['fbSdkVersion', 'adminSdkVersion']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Structural validation for one authored record. Returns problems found (empty = valid). A rig manifest is CI-enforced input, not best-effort, so a malformed file is a hard failure rather than a silently-skipped rig. */
function recordProblems(file: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`scripts/oracle/rigs/${file}: ${message}`);

  if (typeof value !== 'object' || value === null) {
    fail("does not export a 'rig' record object");
    return problems;
  }
  const record = value as Record<string, unknown>;

  if (typeof record.description !== 'string' || !record.description.trim()) fail("missing 'description'");
  if (typeof record.script !== 'string' || !record.script.trim()) fail("missing 'script'");
  const observationPrefixesOk = isStringArray(record.observationPrefixes);
  if (!observationPrefixesOk) {
    fail("'observationPrefixes' must be a string array");
  }
  const pendingOk = record.pendingPrefixes === undefined || isStringArray(record.pendingPrefixes);
  if (!pendingOk) {
    fail("'pendingPrefixes' must be a string array when present");
  }
  if (observationPrefixesOk && pendingOk) {
    const observationPrefixes = record.observationPrefixes as string[];
    const pendingPrefixes = (record.pendingPrefixes as string[] | undefined) ?? [];
    if (observationPrefixes.length + pendingPrefixes.length === 0) {
      fail("a rig must declare at least one prefix across 'observationPrefixes' and 'pendingPrefixes'");
    }
    const overlap = observationPrefixes.filter((prefix) => pendingPrefixes.includes(prefix));
    if (overlap.length > 0) {
      fail(`prefix(es) [${overlap.join(', ')}] appear in BOTH 'observationPrefixes' and 'pendingPrefixes' — a prefix is either captured or pending, not both`);
    }
  }
  if (typeof record.automation !== 'string' || !AUTOMATION_VALUES.has(record.automation as RigAutomation)) {
    fail(`invalid 'automation' (${JSON.stringify(record.automation)})`);
  }
  if (typeof record.network !== 'string' || !NETWORK_VALUES.has(record.network)) {
    fail(`invalid 'network' (${JSON.stringify(record.network)})`);
  }

  const requires = record.requires as Record<string, unknown> | undefined;
  if (typeof requires !== 'object' || requires === null) {
    fail("missing 'requires'");
  } else {
    if (!Array.isArray(requires.env)) {
      fail("'requires.env' must be an array");
    } else {
      (requires.env as unknown[]).forEach((entry, i) => {
        const env = entry as Record<string, unknown> | null;
        if (typeof env !== 'object' || env === null) {
          fail(`requires.env[${i}] is not an object`);
          return;
        }
        if (typeof env.name !== 'string' || !env.name.trim()) fail(`requires.env[${i}] missing 'name'`);
        if (typeof env.description !== 'string' || !env.description.trim()) fail(`requires.env[${i}] missing 'description'`);
        if (env.permission !== undefined && typeof env.permission !== 'string') fail(`requires.env[${i}] 'permission' must be a string`);
      });
    }
    if (!isStringArray(requires.projectFeatures)) fail("'requires.projectFeatures' must be a string array");
    if (!isStringArray(requires.local)) fail("'requires.local' must be a string array");
  }

  const safety = record.safety as Record<string, unknown> | undefined;
  if (typeof safety !== 'object' || safety === null) {
    fail("missing 'safety'");
  } else {
    if (typeof safety.writes !== 'string' || !safety.writes.trim()) fail("missing 'safety.writes'");
    if (typeof safety.cleanup !== 'string' || !safety.cleanup.trim()) fail("missing 'safety.cleanup'");
    if (typeof safety.unattendedSafe !== 'boolean') fail("missing 'safety.unattendedSafe'");
  }

  const freshness = record.freshness as Record<string, unknown> | undefined;
  if (typeof freshness !== 'object' || freshness === null) {
    fail("missing 'freshness'");
  } else {
    if (typeof freshness.versionField !== 'string' || !VERSION_FIELD_VALUES.has(freshness.versionField)) {
      fail(`invalid 'freshness.versionField' (${JSON.stringify(freshness.versionField)})`);
    }
    if (typeof freshness.policy !== 'string' || !freshness.policy.trim()) fail("missing 'freshness.policy'");
  }

  return problems;
}

/**
 * Every strict-prefix relationship between two DIFFERENT rigs' observation
 * prefixes makes longest-prefix ownership ambiguous. A single rig owning both
 * a prefix and a longer prefix built on top of it (e.g. `oracle-run` owning
 * both 'rtdb-' and 'rtdb-modular-') is fine — the same rig owns the file
 * either way. The problem is two DIFFERENT rigs where one's prefix is a
 * strict prefix of the other's.
 */
function crossRigPrefixProblems(manifests: RigManifest[]): string[] {
  const problems: string[] = [];
  const all = manifests.flatMap((m) => m.observationPrefixes.map((prefix) => ({ prefix, id: m.id })));
  for (const a of all) {
    for (const b of all) {
      if (a.id === b.id || a.prefix === b.prefix) continue;
      if (b.prefix.startsWith(a.prefix)) {
        problems.push(
          `observation prefix '${a.prefix}' (rig '${a.id}') is a strict prefix of '${b.prefix}' (rig '${b.id}') — ambiguous longest-prefix ownership across rigs`,
        );
      }
    }
  }
  return problems;
}

/**
 * Loads every rig manifest in this directory. Throws with every problem found
 * (a malformed record, a duplicate prefix, an ambiguous cross-rig prefix)
 * rather than silently dropping a bad file.
 */
export async function loadRigManifests(): Promise<RigManifest[]> {
  const files = readdirSync(HERE)
    .filter((file) => file.endsWith('.ts') && file !== SELF_FILE && file !== TYPES_FILE)
    .sort();

  const problems: string[] = [];
  const manifests: RigManifest[] = [];

  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = (await import(pathToFileURL(join(HERE, file)).href)) as {
      rig?: RigManifestRecord;
      default?: RigManifestRecord;
    };
    const record = mod.rig ?? mod.default;
    const recordFailures = recordProblems(file, record);
    if (recordFailures.length > 0) {
      problems.push(...recordFailures);
      continue;
    }
    manifests.push({ id, ...(record as RigManifestRecord) });
  }

  const prefixOwner = new Map<string, string>();
  for (const manifest of manifests) {
    for (const prefix of manifest.observationPrefixes) {
      const owner = prefixOwner.get(prefix);
      if (owner && owner !== manifest.id) {
        problems.push(`observation prefix '${prefix}' is claimed by both rig '${owner}' and rig '${manifest.id}'`);
      }
      prefixOwner.set(prefix, manifest.id);
    }
  }
  problems.push(...crossRigPrefixProblems(manifests));

  if (problems.length > 0) {
    throw new Error(`Rig manifest loading failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}
