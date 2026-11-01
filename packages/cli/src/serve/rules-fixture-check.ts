import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  SimulateFirestoreRulesHandler,
  TestCaseSchema,
  caseShapeRefusal,
  type TestCase,
} from 'pyric/rules/internal';
import {
  fixtureVerifiableServices,
  parseVerifyFixture,
  VERIFY_FIXTURE_SCHEMA,
  verifyFixture,
  type VerifyDivergence,
  type VerifyRulesInput,
} from '../verify/index.js';
import type { RtdbRulesJson } from '../rtdb/rules-json.js';
import { CAPTURE_RELATIVE_PATH } from './capture-store.js';

export interface RulesFixtureCheckSummary {
  ran: number;
  passed: number;
  failed: number;
  checks: number;
  ok: boolean;
  lines: string[];
}

export interface RunProjectFixturesInput {
  projectDir: string;
  service: 'firestore' | 'rtdb';
  firestoreRules?: string;
  rtdbRules?: RtdbRulesJson;
  rtdbInstance?: string;
}

interface DiscoveredFixtureFile {
  name: string;
  path: string;
}

function discoverProjectFixtureFiles(projectDir: string): DiscoveredFixtureFile[] {
  const found: DiscoveredFixtureFile[] = [];
  const seen = new Set<string>();

  const addFile = (path: string, name: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    try {
      if (!statSync(path).isFile()) return;
    } catch {
      return;
    }
    seen.add(path);
    found.push({ name, path });
  };

  addFile(join(projectDir, CAPTURE_RELATIVE_PATH), 'last-session');

  for (const relDir of ['.pyric/fixtures', 'fixtures']) {
    const dir = join(projectDir, relDir);
    if (!existsSync(dir)) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        addFile(join(dir, file), basename(file, '.json'));
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  return found;
}

/**
 * What a fixture file holds: no Firestore cases, Firestore cases, or cases
 * one of which the case check refuses. A refused fixture is reported, not
 * skipped silently, so a case written with a misspelled field or a create
 * that names a resource is not quietly left out of the check.
 */
type ExtractedCases =
  | { kind: 'none' }
  | { kind: 'refused'; reason: string }
  | { kind: 'cases'; cases: TestCase[] };

function extractFirestoreTestCases(raw: unknown): ExtractedCases {
  let candidateList: unknown[] | null = null;
  if (Array.isArray(raw)) {
    candidateList = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.cases)) {
      candidateList = record.cases;
    } else if (Array.isArray(record.testCases)) {
      candidateList = record.testCases;
    } else if (typeof record.method === 'string' && typeof record.path === 'string') {
      candidateList = [record];
    }
  }
  if (!candidateList || candidateList.length === 0) return { kind: 'none' };
  // A list with no `method` anywhere is some other service's cases, such as
  // Realtime Database cases, which name an `operation`.
  const isFirestoreCaseList = candidateList.some(
    (item) => typeof item === 'object' && item !== null && 'method' in item,
  );
  if (!isFirestoreCaseList) return { kind: 'none' };

  const parsedCases: TestCase[] = [];
  for (const [i, item] of candidateList.entries()) {
    const refusal = caseShapeRefusal(item);
    if (refusal) return { kind: 'refused', reason: `case ${i}: ${refusal}` };
    parsedCases.push(TestCaseSchema.parse(item));
  }
  return { kind: 'cases', cases: parsedCases };
}

function formatDivergenceReason(div: VerifyDivergence): string {
  const method = 'method' in div ? div.method : undefined;
  const target = [method, div.path].filter(Boolean).join(' ');
  const where = target ? ` ${target}` : '';
  if (div.kind === 'now-denied' || div.kind === 'now-allowed' || div.kind === 'unsupported') {
    const detail = div.reason ? ` — ${div.reason.split('\n')[0]}` : '';
    return `${div.service}${where}: ${div.kind}${detail}`;
  }
  if (div.kind === 'state-drift') {
    const field = div.field ? `.${div.field}` : '';
    return `${div.service} ${div.path ?? ''}${field}: state-drift`;
  }
  return `${div.service}${where}: ${div.kind}`;
}

/**
 * Re-run any captured session or rules test-case fixtures in `projectDir`
 * against the newly reloaded rules and format terminal output lines (#371).
 */
export async function runProjectFixturesOnRulesReload(
  input: RunProjectFixturesInput,
): Promise<RulesFixtureCheckSummary> {
  const files = discoverProjectFixtureFiles(input.projectDir);
  let ran = 0;
  let passed = 0;
  let failed = 0;
  let checks = 0;
  const failureLines: string[] = [];
  const warningLines: string[] = [];

  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file.path, 'utf8'));
    } catch {
      continue;
    }

    if (
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      (raw as { schema?: unknown }).schema === VERIFY_FIXTURE_SCHEMA
    ) {
      let fixture;
      try {
        fixture = parseVerifyFixture(raw);
      } catch {
        continue;
      }
      const services = fixtureVerifiableServices(fixture);
      if (!services.includes(input.service)) continue;

      const rulesInput: VerifyRulesInput = {};
      if (input.service === 'firestore') {
        if (!input.firestoreRules) continue;
        rulesInput.firestore = input.firestoreRules;
      } else {
        if (!input.rtdbRules) continue;
        if (input.rtdbInstance) {
          rulesInput.rtdbInstances = { [input.rtdbInstance]: input.rtdbRules };
        } else {
          rulesInput.rtdb = input.rtdbRules;
        }
      }

      try {
        const res = await verifyFixture(fixture, {
          rules: rulesInput,
          services: [input.service],
        });
        const svc = res.services[input.service];
        if (!svc) continue;
        ran += 1;
        checks += svc.checkedEvents;
        if (svc.ok) {
          passed += 1;
        } else {
          failed += 1;
          for (const div of svc.divergences) {
            if (div.kind === 'expected-drift') continue;
            failureLines.push(`    ✗ [${file.name}] ${formatDivergenceReason(div)}`);
          }
        }
      } catch {
        continue;
      }
      continue;
    }

    if (input.service === 'firestore' && input.firestoreRules) {
      const extracted = extractFirestoreTestCases(raw);
      if (extracted.kind === 'refused') {
        warningLines.push(`  ⚠ [pyric] fixtures: [${file.name}] not checked, ${extracted.reason}`);
        continue;
      }
      if (extracted.kind === 'none') continue;
      const testCases = extracted.cases;

      const sim = new SimulateFirestoreRulesHandler().simulate(input.firestoreRules, testCases);
      if (!sim.success) continue;

      ran += 1;
      checks += sim.data.results.length;
      let fixtureOk = true;
      for (const [idx, result] of sim.data.results.entries()) {
        const tc = testCases[idx]!;
        const queryUnprovable =
          tc.method === 'list' &&
          tc.expectation === 'ALLOW' &&
          result.queryProof !== undefined &&
          !result.queryProof.provable;
        const caseOk = result.state === 'PASSED' && !queryUnprovable;
        if (!caseOk) {
          fixtureOk = false;
          const detail = queryUnprovable
            ? `query proof ${result.queryProof?.verdict}: ${result.queryProof?.reason ?? 'unprovable query'}`
            : `expected ${tc.expectation}, got ${result.decision}`;
          failureLines.push(
            `    ✗ [${file.name}] firestore ${tc.method} ${tc.path} (${tc.description}): ${detail.split('\n')[0]}`,
          );
        }
      }
      if (fixtureOk) {
        passed += 1;
      } else {
        failed += 1;
      }
    }
  }

  const ok = failed === 0;
  const lines: string[] = [];
  if (ran > 0) {
    if (ok) {
      lines.push(`  ✓ [pyric] fixtures: ${ran} fixture(s) passed (${checks} check(s))`);
    } else {
      lines.push(`  ⚠ [pyric] fixtures: ${failed}/${ran} fixture(s) regressed:`);
      lines.push(...failureLines);
    }
  }
  lines.push(...warningLines);

  return { ran, passed, failed, checks, ok, lines };
}
