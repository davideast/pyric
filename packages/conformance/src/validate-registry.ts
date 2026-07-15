#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { type Automation, type CompatibilityRow, type CompatStatus } from '../registry/index.ts';
import type { SurfaceDescriptor } from '../surfaces/types.ts';
import { buildCompatibilityLedger, REPO_ROOT, summarizeLedger, type Observation } from './ledger.ts';
import { loadRigManifests } from '../rigs/load.ts';
import type { RigManifest } from '../rigs/types.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../rules-corpus/firestore/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../rules-corpus/storage/index.ts';
import { ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';
import { longestPrefixOwners, soleLongestPrefixOwner } from './observation-surface.ts';
import { listProbeFiles, type ProbeFile } from '../probes/load.ts';
import { computeCriticalSymbols } from './entry-path-symbols.ts';
import { validateEntryPath, type EntryPathCensusRow } from './entry-path-validate.ts';
import { expectedFailures as entryPathExpectedFailures } from '../entry-path/expected-failures.ts';
import { listEntryPathProgramFiles } from '../entry-path/load.ts';
import { deriveConformanceModel } from './conformance-model.ts';

const allowedStatus = new Set<CompatStatus>([
  'conforms',
  'diverged-documented',
  'bug',
  'unsupported',
  'unverified',
]);

const allowedAutomation = new Set<Automation>([
  'oracle-backed',
  'shape-backed',
  'unit-backed',
  'type-backed',
  'sandbox-only',
  'playground-only',
  'unsupported',
  'unverified',
]);

export interface ValidationInput {
  rows: CompatibilityRow[];
  descriptors: SurfaceDescriptor[];
  observations: Observation[];
  observationExceptions: Record<string, string>;
  /** Oracle rig manifests (rigs/*.ts, loaded via load.ts). Optional
   *  so existing tests that don't exercise rig-manifest wiring don't need to
   *  thread it through; the real compat:validate entry point always passes it. */
  rigManifests?: RigManifest[];
  /** Firestore rules corpus scenario ids (rules-corpus/firestore/*.ts, loaded via
   *  load.ts). Optional for the same reason as `rigManifests`; the real
   *  compat:validate entry point always passes it, alongside
   *  `rulesStorageScenarioIds`, so the rules-corpus filename-twin check below is
   *  CI-enforced. */
  rulesFirestoreScenarioIds?: string[];
  /** Storage rules corpus scenario ids (rules-corpus/storage/*.ts). */
  rulesStorageScenarioIds?: string[];
  /** RTDB rules corpus scenario ids (rules-corpus/rtdb/*.ts). */
  rulesRtdbScenarioIds?: string[];
  /** Probe files (probes/<surface>/<name>.ts, loaded via probes/load.ts).
   *  Optional for the same reason as `rigManifests`; the real compat:validate
   *  entry point always passes it, so the twin-path check below (a probe's
   *  surface directory must match its paired observation's) is CI-enforced. */
  probeFiles?: ProbeFile[];
  /** The live surface census (surface-census.ts --json), for the entry-path
   *  critical-symbol + expected-failure citation checks below. Optional for
   *  the same reason as `rigManifests`; the real compat:validate entry point
   *  always passes it (a subprocess call, same pattern as coverage.ts /
   *  census-gate.ts), so the entry-path CLIFF's citation integrity is
   *  CI-enforced. */
  entryPathCensus?: EntryPathCensusRow[];
}

export function validateCompatibilityRegistry(input: ValidationInput): string[] {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  const observationNames = new Set(input.observations.map((obs) => obs.name));
  const observationByName = new Map(input.observations.map((obs) => [obs.name, obs]));

  for (const row of input.rows) {
    ids.set(row.id, (ids.get(row.id) ?? 0) + 1);

    if (row.id !== `${row.surface}#${row.rowRef}`) problems.push(`${row.id}: id must equal surface#rowRef`);
    if (!row.section.trim()) problems.push(`${row.id}: missing section`);
    if (!row.api.trim()) problems.push(`${row.id}: missing api`);
    if (!row.behavior.trim()) problems.push(`${row.id}: missing behavior`);
    if (!allowedStatus.has(row.status)) problems.push(`${row.id}: invalid status '${row.status}'`);
    if (row.statusNote !== undefined && !row.statusNote.trim()) problems.push(`${row.id}: statusNote must not be blank`);
    if (!allowedAutomation.has(row.automation)) problems.push(`${row.id}: invalid automation '${row.automation}'`);
    if (['sandbox-only', 'playground-only', 'unsupported'].includes(row.automation) && !row.exceptionReason?.trim()) {
      problems.push(`${row.id}: ${row.automation} rows require exceptionReason`);
    }
    if (row.riskScore > 0 && row.riskReasons.length === 0) problems.push(`${row.id}: riskScore > 0 requires riskReasons`);
    if (row.automation === 'oracle-backed' && row.oracleObservations.length === 0) problems.push(`${row.id}: oracle-backed row has no oracleObservations`);
    if (row.automation === 'unit-backed' && row.conformanceTests.length === 0) problems.push(`${row.id}: unit-backed row has no conformanceTests`);

    for (const observation of row.oracleObservations) {
      if (!observationNames.has(observation)) problems.push(`${row.id}: observation '${observation}.json' is missing`);
    }
    for (const testPath of row.conformanceTests) {
      if (!existsSync(join(REPO_ROOT, testPath))) problems.push(`${row.id}: conformance test '${testPath}' is missing`);
    }
    for (const check of row.conformanceChecks ?? []) {
      if (!observationNames.has(check.observation)) problems.push(`${row.id}: check ${check.finding} observation '${check.observation}.json' is missing`);
      if (!existsSync(join(REPO_ROOT, check.probe))) problems.push(`${row.id}: check ${check.finding} probe '${check.probe}' is missing`);
      const obs = observationByName.get(check.observation);
      for (const key of Object.keys(check.expect)) {
        if (obs && !(key in obs.behavior)) problems.push(`${row.id}: check ${check.finding} expected behavior key '${key}' is missing from ${check.observation}.json`);
      }
    }

    // Row -> observation direction: every observation a row cites must link
    // the row back through its structured rowIds.
    const citedObservations = new Set([...row.oracleObservations, ...(row.conformanceChecks ?? []).map((check) => check.observation)]);
    for (const observation of citedObservations) {
      const obs = observationByName.get(observation);
      if (obs && !obs.rowIds.includes(row.id)) problems.push(`${observation}.json: cited by ${row.id} but rowIds does not list it`);
    }
  }

  for (const [id, count] of ids) if (count > 1) problems.push(`duplicate row id: ${id} (${count} rows)`);

  const registries = [...new Set(input.descriptors.map((d) => d.registry))];
  for (const registry of registries) {
    const allowedSurfaces = new Set(input.descriptors.filter((d) => d.registry === registry).map((d) => d.surface));
    const registryRows = registry.blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
    if (registryRows.length === 0) problems.push(`${registry.surface}: surface has no rows`);
    for (const row of registryRows) {
      if (!allowedSurfaces.has(row.surface)) problems.push(`${row.id}: row surface does not belong in ${registry.compatPath}`);
    }
  }
  for (const descriptor of input.descriptors) {
    if (!input.rows.some((row) => row.surface === descriptor.surface)) problems.push(`${descriptor.surface}: surface has no rows`);
  }

  // ── Surface descriptor integrity (surfaces/*.ts) ──────────────────────────
  // Each observation filename prefix is owned by exactly one surface; a prefix
  // claimed by two surfaces makes ownership (and the coverage/report split)
  // ambiguous. `rtdb-` / `rtdb-modular-` are DIFFERENT prefixes owned by
  // different surfaces — fine; the check is for the SAME prefix on two surfaces.
  const prefixOwner = new Map<string, string>();
  for (const descriptor of input.descriptors) {
    for (const prefix of descriptor.observationPrefixes) {
      const owner = prefixOwner.get(prefix);
      if (owner && owner !== descriptor.surface) {
        problems.push(`observation prefix '${prefix}' is claimed by both surface '${owner}' and surface '${descriptor.surface}'`);
      }
      prefixOwner.set(prefix, descriptor.surface);
    }
    // A descriptor's conformance suite, if declared, must exist on disk.
    if (descriptor.conformanceSuite && !existsSync(join(REPO_ROOT, descriptor.conformanceSuite))) {
      problems.push(`${descriptor.surface}: conformanceSuite '${descriptor.conformanceSuite}' is missing`);
    }
  }

  const referencedObservations = new Set<string>();
  for (const row of input.rows) {
    for (const observation of row.oracleObservations) referencedObservations.add(observation);
    for (const check of row.conformanceChecks ?? []) referencedObservations.add(check.observation);
  }

  const rowIds = new Set(input.rows.map((row) => row.id));
  for (const obs of input.observations) {
    // Observation -> row direction: every structured link must resolve to a
    // real (canonical) registry row, exceptions included.
    for (const id of obs.rowIds) {
      if (!rowIds.has(id)) problems.push(`${obs.file}: rowIds entry '${id}' does not match a registry row`);
    }
    const descriptor = input.descriptors.find((d) => d.observationPrefixes.some((prefix) => obs.file.startsWith(prefix)));
    if (!descriptor) problems.push(`${obs.file}: filename does not start with a known surface observation prefix`);
    // The observation's own internal `name` field must equal its filename
    // minus `.json` — the filename IS the canonical identity (probes key off
    // it too), so a drifted `name` field would silently desync the two.
    const expectedName = obs.file.replace(/\.json$/, '');
    if (obs.name !== expectedName) problems.push(`${obs.file}: internal name '${obs.name}' does not match filename ('${expectedName}')`);
    // The observation must live in the surface subdirectory its own filename
    // prefix maps to (longest-prefix match, same rule surfaces/*.ts's
    // observationPrefixes define everywhere else) — a file parked under the
    // wrong surface directory is a silent structural drift, fatal here.
    const expectedSurface = soleLongestPrefixOwner(
      obs.file,
      input.descriptors.map((d) => ({ id: d.surface, observationPrefixes: d.observationPrefixes })),
    );
    if (expectedSurface && obs.surfaceDir !== expectedSurface) {
      problems.push(`${obs.file}: lives under observations/${obs.surfaceDir}/ but its prefix maps to surface '${expectedSurface}' (observations/${expectedSurface}/)`);
    }
    if (input.observationExceptions[obs.name]) continue;
    if (!referencedObservations.has(obs.name)) problems.push(`${obs.file}: observation is not referenced by a registry row`);
    if (obs.rowIds.length === 0) problems.push(`${obs.file}: observation has no rowIds`);
  }

  for (const exception of Object.keys(input.observationExceptions)) {
    if (!observationNames.has(exception)) problems.push(`observation exception '${exception}' does not match an observation file`);
  }

  // ── Oracle rig manifests (packages/conformance/rigs/*.ts) ───────────────────────
  // Optional input so tests that don't exercise rig-manifest wiring don't
  // need to thread it through; the real compat:validate entry point below
  // always passes it, so these checks are CI-enforced.
  if (input.rigManifests) {
    const manifests = input.rigManifests;
    const descriptorPrefixes = new Set(input.descriptors.flatMap((d) => d.observationPrefixes));
    const observationFiles = input.observations.map((obs) => obs.file);

    // Every rig id a descriptor names in `captureRigs` must be a real rig.
    const rigIds = new Set(manifests.map((m) => m.id));
    for (const descriptor of input.descriptors) {
      for (const rigId of descriptor.captureRigs) {
        if (!rigIds.has(rigId)) problems.push(`${descriptor.surface}: captureRigs references unknown rig '${rigId}'`);
      }
    }

    for (const manifest of manifests) {
      if (!existsSync(join(REPO_ROOT, manifest.script))) {
        problems.push(`rig '${manifest.id}': script '${manifest.script}' is missing`);
      }
      for (const prefix of manifest.observationPrefixes) {
        // The surface descriptors (surfaces/*.ts) stay the authority on which
        // prefixes are recognized surface observation prefixes; a rig manifest
        // cannot invent one no descriptor declares.
        if (!descriptorPrefixes.has(prefix)) {
          problems.push(`rig '${manifest.id}': observation prefix '${prefix}' is not a recognized surface descriptor prefix (surfaces/*.ts)`);
        }
        // Every declared observation prefix must actually produce something.
        // A prefix a rig WILL produce but hasn't captured yet belongs in
        // `pendingPrefixes` (handled below), not here.
        if (!observationFiles.some((file) => file.startsWith(prefix))) {
          problems.push(`rig '${manifest.id}': observation prefix '${prefix}' matches no observation file`);
        }
      }
      // Pending prefixes: staged machinery ahead of the first capture. Each
      // must still be a recognized surface prefix, but — unlike a real
      // observation prefix — must have NO observation yet. The moment a
      // capture lands, this flips to a failure telling you to promote the
      // prefix into `observationPrefixes`, so a captured file can never sit in
      // a permanently-pending prefix and dodge the ownership/twin checks.
      for (const prefix of manifest.pendingPrefixes ?? []) {
        if (!descriptorPrefixes.has(prefix)) {
          problems.push(`rig '${manifest.id}': pending prefix '${prefix}' is not a recognized surface descriptor prefix (surfaces/*.ts)`);
        }
        if (observationFiles.some((file) => file.startsWith(prefix))) {
          problems.push(`rig '${manifest.id}': pending prefix '${prefix}' now matches a captured observation — promote it into observationPrefixes`);
        }
      }
    }

    for (const obs of input.observations) {
      const owners = longestPrefixOwners(obs.file, manifests);
      if (owners.length === 0) {
        problems.push(`${obs.file}: does not match any rig manifest's observation prefix`);
        continue;
      }
      const distinctManifests = new Set(owners.map((o) => o.ownerId));
      if (distinctManifests.size > 1) {
        problems.push(`${obs.file}: ambiguous longest-prefix match across rigs (${[...distinctManifests].join(', ')})`);
      }
    }
  }

  // ── Rules corpus <-> observation filename-twin integrity ─────────────────
  // Every captured `rules-firestore-<x>.json` / `rules-storage-<x>.json` /
  // `rules-rtdb-<x>.json` observation must have a corpus scenario file `<x>.ts` in
  // the matching rules-corpus directory — an orphan observation (a capture
  // whose scenario was removed or renamed) is a silent-gap failure, fatal here. A
  // scenario WITHOUT an observation is fine (not yet captured); it still shows up
  // in its capture runner's inert plan as capturable, since the runner
  // iterates the same loaded corpus this check does. Scenario ids must also be
  // unique ACROSS all three corpora, not just within each: observation names
  // derive from them, so a collision would make ownership ambiguous.
  //
  // Each engine's orphan check is gated on its own scenario-id set being supplied
  // (optional for tests that don't thread it); the real compat:validate entry
  // point passes all three, so the checks are CI-enforced. Cross-corpus
  // uniqueness is checked pairwise across whichever sets are present.
  const corpora: { dir: string; prefix: string; ids: Set<string> }[] = [];
  if (input.rulesFirestoreScenarioIds) corpora.push({ dir: 'rules-corpus/firestore', prefix: 'rules-firestore-', ids: new Set(input.rulesFirestoreScenarioIds) });
  if (input.rulesStorageScenarioIds) corpora.push({ dir: 'rules-corpus/storage', prefix: 'rules-storage-', ids: new Set(input.rulesStorageScenarioIds) });
  if (input.rulesRtdbScenarioIds) corpora.push({ dir: 'rules-corpus/rtdb', prefix: 'rules-rtdb-', ids: new Set(input.rulesRtdbScenarioIds) });

  for (let a = 0; a < corpora.length; a++) {
    for (let b = a + 1; b < corpora.length; b++) {
      for (const id of corpora[a].ids) {
        if (corpora[b].ids.has(id)) {
          problems.push(`rules corpus: scenario id '${id}' exists in BOTH ${corpora[a].dir}/ and ${corpora[b].dir}/ — scenario ids must be unique across all rules corpora`);
        }
      }
    }
  }

  // Prefixes are mutually non-overlapping ('rules-firestore-' vs 'rules-storage-'
  // vs 'rules-rtdb-'), so the longest matching prefix uniquely identifies the
  // owning corpus. Match longest-first so a hypothetical future nested prefix
  // still resolves to one corpus.
  const byLongestPrefix = [...corpora].sort((x, y) => y.prefix.length - x.prefix.length);
  for (const obs of input.observations) {
    const owner = byLongestPrefix.find((c) => obs.file.startsWith(c.prefix));
    if (!owner) continue;
    const scenarioId = obs.file.slice(owner.prefix.length).replace(/\.json$/, '');
    if (!owner.ids.has(scenarioId)) {
      problems.push(`${obs.file}: no matching ${owner.dir}/${scenarioId}.ts scenario — orphan observation`);
    }
  }

  // ── Probe <-> observation twin-path integrity ─────────────────────────────
  // `probes/<surface>/<name>.ts` is the twin tree to `observations/<surface>/
  // <name>.json`: where a probe exists, its surface subdirectory must match
  // the directory of the observation it produces. A probe without a matching
  // observation (not yet captured) is fine — only a DIRECTORY MISMATCH between
  // the two trees is fatal here.
  if (input.probeFiles) {
    const observationDirByName = new Map(input.observations.map((obs) => [obs.name, obs.surfaceDir]));
    for (const probe of input.probeFiles) {
      const obsDir = observationDirByName.get(probe.name);
      if (obsDir && obsDir !== probe.surfaceDir) {
        problems.push(`probes/${probe.surfaceDir}/${probe.name}.ts: paired observation lives under observations/${obsDir}/, not observations/${probe.surfaceDir}/`);
      }
    }
  }

  // ── Entry-path critical-set + expected-failure citation integrity ────────
  // Optional for the same reason as `rigManifests` etc.; the real
  // compat:validate entry point below always passes a live census, so the
  // entry-path CLIFF's citation integrity (entry-path-gate.ts, wired into
  // compat:check) is CI-enforced: every symbol the corpus needs is either
  // census-mapped right now, or covered by an expected-failure record that
  // itself cites a real, currently-existing gap.
  if (input.entryPathCensus) {
    problems.push(
      ...validateEntryPath({
        criticalSymbols: computeCriticalSymbols(),
        expectedFailures: entryPathExpectedFailures,
        census: input.entryPathCensus,
        ledgerRowStatuses: new Map(input.rows.map((row) => [row.id, row.status])),
        programNames: listEntryPathProgramFiles().map((f) => f.name),
      }),
    );
  }


  return problems;
}

/**
 * Runs surface-census.ts as a subprocess (same pattern as coverage.ts /
 * census-gate.ts's own `runCensus()`) so the entry-path checks above see the
 * live mapped/unmapped sets, not a stale in-process snapshot. The census
 * exits 1 on any UNMAPPED gap — expected steady state, not a validate-
 * registry failure in itself — so a non-zero exit is tolerated as long as
 * stdout parses.
 */
function runEntryPathCensus(): EntryPathCensusRow[] {
  const script = join(REPO_ROOT, 'packages', 'conformance', 'src', 'surface-census.ts');
  try {
    const out = execFileSync('bun', ['run', script, '--json'], { encoding: 'utf8', cwd: REPO_ROOT });
    return (JSON.parse(out) as { surfaces: EntryPathCensusRow[] }).surfaces;
  } catch (err) {
    const e = err as { stdout?: string };
    if (!e.stdout) throw err;
    return (JSON.parse(e.stdout) as { surfaces: EntryPathCensusRow[] }).surfaces;
  }
}

if (import.meta.main) {
  const model = await deriveConformanceModel();
  const ledger = buildCompatibilityLedger(model);
  const summary = summarizeLedger(ledger, model);
  const rigManifests = await loadRigManifests();
  const problems = validateCompatibilityRegistry({
    rows: [...model.documentation.rows],
    descriptors: [...model.documentation.descriptors],
    observations: [...model.evidence.observations],
    observationExceptions: { ...model.evidence.observationExceptions },
    rigManifests,
    probeFiles: listProbeFiles(),
    rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((scenario) => scenario.id),
    rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((scenario) => scenario.id),
    rulesRtdbScenarioIds: ALL_RULES_RTDB_SCENARIOS.map((scenario) => scenario.id),
    entryPathCensus: runEntryPathCensus(),
  });

  const wantJson = process.argv.includes('--json');
  if (wantJson) {
    console.log(JSON.stringify({ summary, problems }, null, 2));
  } else {
    console.log('# Compatibility registry validation\n');
    console.log(`Rows: ${summary.totalRows}`);
    console.log(`Observations: ${summary.observations}`);
    console.log(`Conformance checks: ${summary.conformanceChecks}`);
    console.log(`Problems: ${problems.length}`);
    if (problems.length > 0) {
      console.log('');
      for (const problem of problems) console.error(`- ${problem}`);
    }
  }

  process.exit(problems.length === 0 ? 0 : 1);
}
