/**
 * `pyric assurance derive` CLI subcommand:
 * runs Tri-Source static passes (`staticQueryProofPass`, `storageContractPass`,
 * `coverageMatrixPass`, `checkRtdbIndexes`) alongside real-write `runProbes`,
 * optionally cloning live state + history from a loopback sandbox (`--port` / `--url`).
 */
import { resolve } from 'node:path';
import {
  shouldFailOnDiagnostic,
  type AssuranceDiagnostic,
  type DiagnosticSeverity,
} from 'pyric/sandbox/internal';
import {
  deriveAssurance,
  type DeriveAssuranceInput,
  type DeriveAssuranceResult,
} from '../assurance/derive.js';
import type { AssuranceCampaignStore } from '../assurance/tools.js';
import { findMissingValueFlag, type FlagValue, type ParsedArgs } from './parse-args.js';

export interface AssuranceCliDeps {
  readonly cwd?: string;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
  readonly fetchImpl?: typeof fetch;
  readonly store?: AssuranceCampaignStore;
}

export interface ParsedFailGate {
  readonly ok: true;
  readonly matches: (diagnostic: AssuranceDiagnostic) => boolean;
}

export interface InvalidFailGate {
  readonly ok: false;
  readonly message: string;
}

const SEVERITY_VALUES: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

function readStringFlag(value: FlagValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value.at(-1);
    if (typeof last === 'string') return last;
  }
  return undefined;
}

export function readBooleanFlag(value: FlagValue | undefined): boolean {
  if (value === true || value === 'true') return true;
  if (Array.isArray(value)) {
    return value.some((v) => v === true || v === 'true');
  }
  return false;
}

export function resolveFailGate(
  rawFailOn: FlagValue | undefined,
  includeHeuristicFlag: boolean,
): ParsedFailGate | InvalidFailGate {
  const token = readStringFlag(rawFailOn)?.trim().toLowerCase();
  if (token === undefined || token.length === 0) {
    return {
      ok: true,
      matches: (d) =>
        shouldFailOnDiagnostic(d, { includeHeuristic: includeHeuristicFlag }),
    };
  }

  if (token === 'proven-counterexample') {
    return {
      ok: true,
      matches: (d) => d.certainty === 'proven-counterexample',
    };
  }

  if (token === 'static-proof') {
    return {
      ok: true,
      matches: (d) => d.certainty === 'static-proof',
    };
  }

  if (token === 'heuristic') {
    return {
      ok: true,
      matches: (d) => shouldFailOnDiagnostic(d, { includeHeuristic: true }),
    };
  }

  if (SEVERITY_VALUES.has(token)) {
    const minSeverity = token as DiagnosticSeverity;
    return {
      ok: true,
      matches: (d) =>
        shouldFailOnDiagnostic(d, {
          minSeverity,
          includeHeuristic: includeHeuristicFlag,
        }),
    };
  }

  return {
    ok: false,
    message: `invalid --fail-on value '${token}'; expected proven-counterexample, static-proof, heuristic, critical, high, medium, or low`,
  };
}

export function formatAssuranceDiagnosticsText(
  header: string,
  diagnostics: readonly AssuranceDiagnostic[],
  studioUrl?: string,
): string {
  const lines: string[] = [header];
  if (studioUrl !== undefined) {
    lines.push(`  studio: ${studioUrl}`);
  }
  for (const d of diagnostics) {
    let loc = '';
    if (d.codeSite?.source) {
      loc = ` @ ${d.codeSite.source}`;
    } else if (d.ruleSite?.source) {
      loc = ` @ ${d.ruleSite.source}`;
    }
    lines.push(
      `  [${d.severity}/${d.certainty}] (${d.service}) ${d.code}${loc}: ${d.message}`,
    );
    if (d.remediation) {
      lines.push(`    fix: ${d.remediation}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function resolveLoopbackUrl(
  portFlag: FlagValue | undefined,
  urlFlag: FlagValue | undefined,
): { ok: true; url?: string } | { ok: false; message: string } {
  const explicitUrl = readStringFlag(urlFlag);
  const rawPort = readStringFlag(portFlag);
  if (explicitUrl !== undefined && rawPort !== undefined) {
    return {
      ok: false,
      message: 'pass either --port or --url, not both',
    };
  }
  if (explicitUrl !== undefined) {
    return { ok: true, url: explicitUrl };
  }
  if (rawPort !== undefined) {
    const parsedPort = Number(rawPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return {
        ok: false,
        message: `invalid --port '${rawPort}'; expected an integer between 1 and 65535`,
      };
    }
    return { ok: true, url: `http://127.0.0.1:${parsedPort}` };
  }
  return { ok: true };
}

export async function runAssuranceDerive(
  parsed: ParsedArgs,
  deps: AssuranceCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const missingFlag = findMissingValueFlag(parsed.flags, [
    'port',
    'url',
    'fail-on',
    'root',
    'campaign-id',
  ]);
  if (missingFlag !== undefined) {
    stderr.write(`pyric assurance derive: missing value for --${missingFlag}\n`);
    return 2;
  }
  const json = readBooleanFlag(parsed.flags.get('json'));
  const includeHeuristicFlag = readBooleanFlag(
    parsed.flags.get('include-heuristic'),
  );

  const gate = resolveFailGate(
    parsed.flags.get('fail-on'),
    includeHeuristicFlag,
  );
  if (!gate.ok) {
    stderr.write(`pyric assurance derive: ${gate.message}\n`);
    return 2;
  }

  const targetUrl = resolveLoopbackUrl(
    parsed.flags.get('port'),
    parsed.flags.get('url'),
  );
  if (!targetUrl.ok) {
    stderr.write(`pyric assurance derive: ${targetUrl.message}\n`);
    return 2;
  }

  let rawRoot = readStringFlag(parsed.flags.get('root'));
  if (rawRoot === undefined && typeof parsed.positional[1] === 'string') {
    rawRoot = parsed.positional[1];
  }
  let resolvedRoot = cwd;
  if (rawRoot !== undefined && rawRoot.trim().length > 0) {
    resolvedRoot = resolve(cwd, rawRoot);
  }

  const includeStatic = !readBooleanFlag(parsed.flags.get('no-static'));
  const campaignId = readStringFlag(parsed.flags.get('campaign-id'));

  const input: {
    root: string;
    url?: string;
    campaignId?: string;
    includeStaticChecks: boolean;
    includeHeuristic: boolean;
  } = {
    root: resolvedRoot,
    includeStaticChecks: includeStatic,
    includeHeuristic: true,
  };
  if (targetUrl.url !== undefined) input.url = targetUrl.url;
  if (campaignId !== undefined) input.campaignId = campaignId;

  const deriveDeps: {
    store?: AssuranceCampaignStore;
    fetchImpl?: typeof fetch;
    projectDir?: string;
  } = {};
  if (deps.store !== undefined) deriveDeps.store = deps.store;
  if (deps.fetchImpl !== undefined) deriveDeps.fetchImpl = deps.fetchImpl;
  if (targetUrl.url !== undefined) deriveDeps.projectDir = resolvedRoot;

  let derived: DeriveAssuranceResult;
  try {
    derived = await deriveAssurance(input as DeriveAssuranceInput, deriveDeps);
  } catch (err) {
    let msg = String(err);
    if (err instanceof Error) msg = err.message;
    stderr.write(`pyric assurance derive: ${msg}\n`);
    return 2;
  }

  const failing = derived.diagnostics.some((d) => gate.matches(d));
  const ok = !failing;

  if (json) {
    stdout.write(`${JSON.stringify({ ok, ...derived }, null, 2)}\n`);
  } else {
    const ce = derived.counts.byCertainty['proven-counterexample'];
    const sp = derived.counts.byCertainty['static-proof'];
    const he = derived.counts.byCertainty.heuristic;
    const header = `pyric assurance derive (${derived.campaignId}): ${ce} counterexample(s), ${sp} static proof failure(s), ${he} heuristic hint(s)`;
    stdout.write(
      formatAssuranceDiagnosticsText(
        header,
        derived.diagnostics,
        derived.studioUrl,
      ),
    );
  }

  if (failing) return 1;
  return 0;
}
