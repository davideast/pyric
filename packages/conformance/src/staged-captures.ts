/**
 * Staged uncaptured probe and corpus discovery.
 *
 * Enables the three-PR automated capture flow without weakening registry gates:
 *   1. PR #1 lands a staged scenario or probe marked `pendingRowLink: true`
 *      with no observation JSON yet (`compat:check` stays green).
 *   2. `oracle-capture.yml` runs on `main`, captures the observation against
 *      production Firebase, and opens PR #2 touching ONLY
 *      `packages/conformance/observations/**` with `rowIds: []` (`compat:check`
 *      stays green because `pendingRowLink` recognizes the unlinked capture).
 *   3. PR #3 links `rowIds` in `registry/*.ts`, updates replay/baselines, and
 *      removes `pendingRowLink: true` (`compat:validate` enforces removal once
 *      `rowIds` is non-empty).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProbeFiles } from '../probes/load.ts';
import { loadObservations } from '../observations/load.ts';
import {
  ALL_RULES_FIRESTORE_SCENARIOS,
  observationName as firestoreObservationName,
} from '../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  storageObservationName,
} from '../rules-corpus/storage/index.ts';
import { MESSAGING_SEND_PROBES } from './messaging-send-probe-catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES_ROOT = join(HERE, '..', 'probes');

export interface StagedCaptureItem {
  rig: string;
  observationName: string;
  filterFlag?: '--scenario' | '--probe';
  filterValue?: string;
}

const PROBE_PREFIX_TO_RIG: ReadonlyArray<{ prefix: string; rig: string }> = [
  { prefix: 'admin-app-', rig: 'admin-app' },
  { prefix: 'app-registry-', rig: 'app-registry' },
  { prefix: 'client-storage-', rig: 'client-storage' },
  { prefix: 'storage-admin-', rig: 'storage-admin' },
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function probeFileDeclaresPendingRowLink(surfaceDir: string, name: string): boolean {
  const fullPath = join(PROBES_ROOT, surfaceDir, `${name}.ts`);
  const source = stripComments(readFileSync(fullPath, 'utf8'));
  return /\bpendingRowLink\s*:\s*true\b/.test(source);
}

function rigForProbeName(name: string): string | undefined {
  return PROBE_PREFIX_TO_RIG.find(({ prefix }) => name.startsWith(prefix))?.rig;
}

/** Every authored scenario or probe currently marked `pendingRowLink: true`. */
function loadStagedCaptureItems(): StagedCaptureItem[] {
  const items: StagedCaptureItem[] = [];

  for (const scenario of ALL_RULES_FIRESTORE_SCENARIOS) {
    if (scenario.pendingRowLink) {
      items.push({
        rig: 'rules-firestore',
        observationName: firestoreObservationName(scenario),
        filterFlag: '--scenario',
        filterValue: scenario.id,
      });
    }
  }

  for (const scenario of ALL_RULES_STORAGE_SCENARIOS) {
    if (scenario.pendingRowLink) {
      items.push({
        rig: 'rules-storage',
        observationName: storageObservationName(scenario),
        filterFlag: '--scenario',
        filterValue: scenario.id,
      });
    }
  }

  for (const probeFile of listProbeFiles()) {
    if (!probeFileDeclaresPendingRowLink(probeFile.surfaceDir, probeFile.name)) continue;
    const rig = rigForProbeName(probeFile.name);
    if (!rig) continue;
    items.push({
      rig,
      observationName: probeFile.name,
      filterFlag: '--probe',
      filterValue: probeFile.name,
    });
  }

  for (const probe of MESSAGING_SEND_PROBES) {
    if (!probe.pendingRowLink) continue;
    items.push({
      rig: 'messaging-send',
      observationName: probe.name,
      filterFlag: '--probe',
      filterValue: probe.name,
    });
  }

  return items.sort(
    (a, b) => a.rig.localeCompare(b.rig) || a.observationName.localeCompare(b.observationName),
  );
}

/** Observation stems (without `.json`) whose probe/scenario declares `pendingRowLink: true`. */
export function loadPendingRowLinkObservations(): Set<string> {
  return new Set(loadStagedCaptureItems().map((item) => item.observationName));
}

export interface DiscoverUncapturedOptions {
  existingObservationNames?: ReadonlySet<string>;
  stagedItems?: readonly StagedCaptureItem[];
}

/** Staged items that do not yet have a committed observation file under `observations/`. */
export function discoverUncapturedStagedTargets(
  options: DiscoverUncapturedOptions = {},
): StagedCaptureItem[] {
  const existing =
    options.existingObservationNames ??
    new Set(loadObservations().map((obs) => obs.name));
  const staged = options.stagedItems ?? loadStagedCaptureItems();
  return [...staged]
    .filter((item) => !existing.has(item.observationName))
    .sort(
      (a, b) => a.rig.localeCompare(b.rig) || a.observationName.localeCompare(b.observationName),
    );
}
