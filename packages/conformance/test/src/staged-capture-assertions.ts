import { expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadObservations } from '../../src/ledger.ts';
import {
  discoverUncapturedStagedTargets,
  loadStagedCaptureItems,
  type StagedCaptureItem,
} from '../../src/staged-captures.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_TEST_ROOT = join(HERE, '..');

const ALLOWED_DIRECT_STAGED_DISCOVERY_TESTS = new Set([
  'src/staged-captures.test.ts',
  'src/staged-modular-probes.test.ts',
]);

interface StagedUntilCapturedOptions {
  rig?: string;
  filterFlag?: '--scenario' | '--probe';
  filterValueFor?: (observationName: string) => string;
  existingObservationNames?: ReadonlySet<string>;
  stagedItems?: readonly StagedCaptureItem[];
  whenUncaptured?: (observationName: string) => void;
  whenCaptured?: (observationName: string) => void;
}

interface TestSourceEntry {
  relPath: string;
  source: string;
}

function normalizeObservationNames(
  observationNames: string | readonly string[],
): readonly string[] {
  if (typeof observationNames === 'string') {
    return [observationNames];
  }
  return observationNames;
}

function resolveExistingObservationNames(
  override: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (override !== undefined) {
    return override;
  }
  const observations = loadObservations();
  return new Set(observations.map((obs) => obs.name));
}

function resolveStagedItems(
  override: readonly StagedCaptureItem[] | undefined,
): readonly StagedCaptureItem[] {
  if (override !== undefined) {
    return override;
  }
  return loadStagedCaptureItems();
}

/**
 * Asserts that each named probe or scenario declares `pendingRowLink: true`
 * across both PR #1 (observation file absent -> listed as uncaptured) and
 * PR #2 (observation file captured with `rowIds: []` -> excluded from
 * uncaptured targets while staying `pendingRowLink` until PR #3 links `rowIds`).
 */
export function expectStagedUntilCaptured(
  observationNames: string | readonly string[],
  options: StagedUntilCapturedOptions = {},
): void {
  const names = normalizeObservationNames(observationNames);
  const existingNames = resolveExistingObservationNames(options.existingObservationNames);
  const stagedItems = resolveStagedItems(options.stagedItems);
  const stagedByName = new Map(stagedItems.map((item) => [item.observationName, item]));
  const uncaptured = discoverUncapturedStagedTargets({
    existingObservationNames: existingNames,
    stagedItems,
  });
  const uncapturedByName = new Map(uncaptured.map((item) => [item.observationName, item]));

  for (const name of names) {
    const stagedItem = stagedByName.get(name);
    expect(stagedItem, `expected ${name} to declare pendingRowLink: true`).toBeDefined();
    if (!stagedItem) {
      continue;
    }
    if (options.rig !== undefined) {
      expect(stagedItem.rig).toBe(options.rig);
    }
    if (options.filterFlag !== undefined) {
      expect(stagedItem.filterFlag).toBe(options.filterFlag);
    }
    if (options.filterValueFor !== undefined) {
      expect(stagedItem.filterValue).toBe(options.filterValueFor(name));
    }

    if (!existingNames.has(name)) {
      expect(uncapturedByName.get(name)).toEqual(stagedItem);
      if (options.whenUncaptured) {
        options.whenUncaptured(name);
      }
    } else {
      expect(uncapturedByName.has(name)).toBe(false);
      if (options.whenCaptured) {
        options.whenCaptured(name);
      }
    }
  }
}

function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function collectTestFilesUnder(dirPath: string, rootPath: string, out: TestSourceEntry[]): void {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectTestFilesUnder(fullPath, rootPath, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) {
      continue;
    }
    const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');
    out.push({
      relPath,
      source: readFileSync(fullPath, 'utf8'),
    });
  }
}

function loadDefaultConformanceTestFiles(): TestSourceEntry[] {
  const files: TestSourceEntry[] = [];
  collectTestFilesUnder(CONFORMANCE_TEST_ROOT, CONFORMANCE_TEST_ROOT, files);
  return files;
}

const LIVE_UNFILTERED_WRITE_SCENARIOS_RE =
  /\bselect(?:Storage|Firestore)Scenarios\s*\(\s*\[\s*['"]--write['"]\s*\]\s*\)/;

/**
 * Scans conformance `.test.ts` files and returns violations for any suite that
 * asserts uncaptured staged state without routing through `expectStagedUntilCaptured`.
 */
export function auditStagedCaptureTestFiles(
  overrideFiles?: readonly TestSourceEntry[],
): string[] {
  let files: readonly TestSourceEntry[];
  if (overrideFiles !== undefined) {
    files = overrideFiles;
  } else {
    files = loadDefaultConformanceTestFiles();
  }

  const violations: string[] = [];
  for (const file of files) {
    if (ALLOWED_DIRECT_STAGED_DISCOVERY_TESTS.has(file.relPath)) {
      continue;
    }
    const cleaned = stripSourceComments(file.source);
    if (/\bdiscoverUncapturedStagedTargets\b/.test(cleaned)) {
      violations.push(
        `${file.relPath}: references discoverUncapturedStagedTargets directly; use expectStagedUntilCaptured from test/src/staged-capture-assertions.ts so PR #2 observation captures stay green`,
      );
    }
    if (/\bloadStagedCaptureItems\b/.test(cleaned)) {
      violations.push(
        `${file.relPath}: references loadStagedCaptureItems directly; use expectStagedUntilCaptured from test/src/staged-capture-assertions.ts`,
      );
    }
    if (LIVE_UNFILTERED_WRITE_SCENARIOS_RE.test(cleaned)) {
      const usesHelper = /\bexpectStagedUntilCaptured\s*\(/.test(cleaned);
      const guardsUncaptured = /\bwhenUncaptured\s*:/.test(cleaned);
      if (!usesHelper || !guardsUncaptured) {
        violations.push(
          `${file.relPath}: calls live select*Scenarios(['--write']) without expectStagedUntilCaptured(..., { whenUncaptured, whenCaptured }); guard live runner-exclusion assertions for PR #2 captures`,
        );
      }
    }
  }
  return violations;
}
