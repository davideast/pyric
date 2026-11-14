/**
 * `pyric verify --static` CLI handler:
 * runs Tri-Source static assurance passes (`staticQueryProofPass`,
 * `storageContractPass`, `checkRtdbIndexes`, and `coverageMatrixPass`)
 * against project code and security rules before any runtime capture exists.
 */
import { resolve } from 'node:path';
import type {
  AssuranceDiagnostic,
  AssuranceService,
} from 'pyric/sandbox/internal';
import {
  runStaticAssurancePasses,
  summarizeDiagnosticCounts,
} from '../assurance/derive.js';
import {
  loadAssuranceProject,
  resolveDeriveRoot,
} from '../assurance/derive-project.js';
import {
  formatAssuranceDiagnosticsText,
  readBooleanFlag,
  resolveFailGate,
} from './assurance.js';
import {
  findMissingValueFlag,
  findUnknownFlag,
  formatCliFlagName,
  type FlagValue,
  type ParsedArgs,
} from './parse-args.js';
import {
  applyRulesFlagOverrides,
  readStringValues,
} from './verify-static-rules-override.js';

const ALLOWED_VERIFY_STATIC_FLAGS: ReadonlySet<string> = new Set([
  'static',
  'rules',
  'service',
  'root',
  'fail-on',
  'json',
  'include-heuristic',
]);

export interface VerifyStaticCliDeps {
  readonly cwd?: string;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
}

function parseServiceFilter(
  rawService: FlagValue | undefined,
): { ok: true; services?: ReadonlySet<AssuranceService> } | { ok: false; message: string } {
  const tokens = readStringValues(rawService)
    .flatMap((part) => part.split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (tokens.length === 0) return { ok: true };

  const selected = new Set<AssuranceService>();
  for (const token of tokens) {
    if (token === 'firestore') {
      selected.add('firestore');
    } else if (token === 'rtdb' || token === 'database') {
      selected.add('rtdb');
    } else if (token === 'storage') {
      selected.add('storage');
    } else {
      return {
        ok: false,
        message: `unknown --service '${token}'; expected firestore, rtdb, database, or storage`,
      };
    }
  }
  return { ok: true, services: selected };
}

export async function runVerifyStatic(
  parsed: ParsedArgs,
  deps: VerifyStaticCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const unknownFlag = findUnknownFlag(parsed.flags, ALLOWED_VERIFY_STATIC_FLAGS);
  if (unknownFlag !== undefined) {
    stderr.write(
      `pyric verify --static: unknown option '${formatCliFlagName(unknownFlag)}'\n`,
    );
    return 2;
  }
  const missingFlag = findMissingValueFlag(parsed.flags, [
    'rules',
    'service',
    'root',
    'fail-on',
  ]);
  if (missingFlag !== undefined) {
    stderr.write(`pyric verify --static: missing value for --${missingFlag}\n`);
    return 2;
  }
  const json = readBooleanFlag(parsed.flags.get('json'));
  const includeHeuristic = readBooleanFlag(parsed.flags.get('include-heuristic'));

  const gate = resolveFailGate(parsed.flags.get('fail-on'), includeHeuristic);
  if (!gate.ok) {
    stderr.write(`pyric verify --static: ${gate.message}\n`);
    return 2;
  }

  const serviceFilter = parseServiceFilter(parsed.flags.get('service'));
  if (!serviceFilter.ok) {
    stderr.write(`pyric verify --static: ${serviceFilter.message}\n`);
    return 2;
  }

  const rootValues = readStringValues(parsed.flags.get('root'));
  let rawRoot = rootValues.at(-1);
  if (rawRoot === undefined && typeof parsed.positional[0] === 'string') {
    rawRoot = parsed.positional[0];
  }
  let targetRoot = cwd;
  if (rawRoot !== undefined && rawRoot.trim().length > 0) {
    targetRoot = resolve(cwd, rawRoot);
  }

  let absRoot: string;
  try {
    absRoot = resolveDeriveRoot(targetRoot, undefined);
  } catch (err) {
    let msg = String(err);
    if (err instanceof Error) msg = err.message;
    stderr.write(`pyric verify --static: ${msg}\n`);
    return 2;
  }

  const baseProject = loadAssuranceProject(absRoot);
  const overridden = applyRulesFlagOverrides(
    baseProject,
    parsed.flags.get('rules'),
    cwd,
    targetRoot,
  );
  if (!overridden.ok) {
    stderr.write(`pyric verify --static: ${overridden.message}\n`);
    return 2;
  }

  let diagnostics: AssuranceDiagnostic[] = runStaticAssurancePasses(
    overridden.project,
  );
  if (serviceFilter.services !== undefined) {
    const allowed = serviceFilter.services;
    diagnostics = diagnostics.filter(
      (d) =>
        allowed.has(d.service)
        || (d.code === 'invalid-rules-configuration'
          && d.ruleSite?.source === 'firebase.json'),
    );
  }

  const counts = summarizeDiagnosticCounts(diagnostics);
  const failing = diagnostics.some((d) => gate.matches(d));
  const ok = !failing;

  if (json) {
    stdout.write(`${JSON.stringify({ ok, counts, diagnostics }, null, 2)}\n`);
  } else {
    const sp = counts.byCertainty['static-proof'];
    const he = counts.byCertainty.heuristic;
    const header = `pyric verify --static: ${sp} static proof failure(s), ${he} heuristic hint(s)`;
    stdout.write(formatAssuranceDiagnosticsText(header, diagnostics));
  }

  if (failing) return 1;
  return 0;
}
