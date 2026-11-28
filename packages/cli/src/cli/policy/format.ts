/**
 * Pure 7-bit ASCII help text, human-readable summaries, and stable JSON
 * formatting for `pyric policy <check|prove|emit>`.
 */
import type {
  PolicyCheckReport,
  PolicyCliDiagnostic,
  PolicyCommandName,
  PolicyEmitReport,
  PolicyPlacementSummary,
  PolicyProveReport,
  TargetPlacementReport,
} from './types.js';

export function formatJson(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderPolicyHelp(subcommand?: string): string {
  if (subcommand === 'check') {
    return [
      'pyric policy check',
      '',
      'Parse, statically check, inspect target placement splits, and estimate',
      'expression-unit cost budgets for a policy source file.',
      '',
      'USAGE',
      '  pyric policy check <file|-> [flags]',
      '',
      'FLAGS',
      '  --kind <transition|function|module>  Override policy dialect auto-detection',
      '  --expression-limit <N>               Override expression budget limit',
      '  --config <path>                      JSON config file (CLI flags override)',
      '  --firestore-bindings <path>          Firestore binding projections JSON',
      '  --storage-bindings <path>            Storage binding projections JSON',
      '  --rtdb-bindings <path>               RTDB snapshot bindings JSON',
      '  --mode <mixed|complete>              Placement gate (default: mixed)',
      '  --json                               Emit pyric.policy.check.v1 JSON',
      '  --help, -h                           Show this help text',
      '',
      'EXIT CODES',
      '  0  Passed all checks',
      '  1  Usage, argument, or file I/O error',
      '  2  Syntax or static-check error',
      '  3  Placement residual in complete mode or standalone emission error',
      '',
    ].join('\n');
  }
  if (subcommand === 'prove') {
    return [
      'pyric policy prove',
      '',
      'Run static checks, target placement analysis, standalone ESM load verification,',
      'scenario replay, and deterministic seeded differential fuzzing.',
      '',
      'USAGE',
      '  pyric policy prove <file|-> [flags]',
      '',
      'FLAGS',
      '  --kind <transition|function|module>  Override policy dialect auto-detection',
      '  --expression-limit <N>               Override expression budget limit',
      '  --config <path>                      JSON config file (CLI flags override)',
      '  --firestore-bindings <path>          Firestore binding projections JSON',
      '  --storage-bindings <path>            Storage binding projections JSON',
      '  --rtdb-bindings <path>               RTDB snapshot bindings JSON',
      '  --scenarios <path>                   Scenario list JSON file',
      '  --mode <mixed|complete>              Placement gate (default: mixed)',
      '  --seed <uint32>                      PRNG seed for fuzzing (default: 1337)',
      '  --fuzz-cases <0..2000>               Fuzz case count (default: 64)',
      '  --max-duration-ms <100..60000>       Fuzz wall-clock budget (default: 10000)',
      '  --no-fuzz                            Disable differential fuzzing',
      '  --no-adversarial                     Disable adversarial fuzz scalars',
      '  --no-esm-verify                      Skip temp .mjs dynamic import check',
      '  --json                               Emit pyric.policy.prove.v1 JSON',
      '  --help, -h                           Show this help text',
      '',
      'EXIT CODES',
      '  0  Proof passed with zero scenario failures and zero divergences',
      '  1  Usage, argument, or file I/O error',
      '  2  Syntax or static-check error',
      '  3  Placement residual in complete mode or standalone ESM error',
      '  4  Scenario expectation failure or differential fuzz divergence',
      '',
    ].join('\n');
  }
  if (subcommand === 'emit') {
    return [
      'pyric policy emit',
      '',
      'Emit native Firestore, Storage, and/or RTDB rules alongside a standalone',
      'zero-dependency ES module in one command.',
      '',
      'USAGE',
      '  pyric policy emit <file|-> --out-dir <dir> [flags]',
      '',
      'FLAGS',
      '  --out-dir <dir>                      Output directory (required unless --no-write)',
      '  --name <stem>                        Output filename stem (default: policy name)',
      '  --targets <csv>                      Subset of standalone,firestore,storage,rtdb',
      '  --target <name>                      Alias for --targets (repeatable)',
      '  --mode <complete|mixed>              Target lowering mode (default: complete)',
      '  --kind <transition|function|module>  Override policy dialect auto-detection',
      '  --expression-limit <N>               Override expression budget limit',
      '  --config <path>                      JSON config file (CLI flags override)',
      '  --firestore-bindings <path>          Firestore bindings JSON (emits 2+modules)',
      '  --firestore-template <path>          Firestore template JSON (composes ruleset)',
      '  --storage-bindings <path>            Storage bindings JSON (emits 2+modules)',
      '  --storage-template <path>            Storage template JSON (composes ruleset)',
      '  --rtdb-bindings <path>               RTDB bindings JSON (emits rules.json)',
      '  --rtdb-path <path>                   Absolute RTDB node path (e.g. /rooms/$id)',
      '  --manifest <path>                    Write JSON build manifest to this path',
      '  --no-standalone                      Skip standalone .mjs emission',
      '  --no-write                           Dry run: validate without writing files',
      '  --no-esm-verify                      Skip temp .mjs dynamic import check',
      '  --json                               Emit pyric.policy.emit.v1 JSON',
      '  --help, -h                           Show this help text',
      '',
      'EXIT CODES',
      '  0  Emission succeeded',
      '  1  Usage, argument, or file I/O error',
      '  2  Syntax or static-check error',
      '  3  Target lowering, template composition, or standalone emission error',
      '',
    ].join('\n');
  }
  return [
    'pyric policy',
    '',
    'Compile, verify, prove, and emit experimental Pyric policy programs.',
    '',
    'USAGE',
    '  pyric policy <check|prove|emit> <file|-> [flags]',
    '',
    'SUBCOMMANDS',
    '  check   Parse, statically check, inspect placement split and cost budgets',
    '  prove   Run static checks, placement, scenarios, and differential fuzzing',
    '  emit    Emit standalone ES module and Firestore/Storage/RTDB rules',
    '',
    'Run `pyric policy <subcommand> --help` for detailed flags and exit codes.',
    '',
  ].join('\n');
}

function formatDiagnosticLines(diagnostics: readonly PolicyCliDiagnostic[]): string[] {
  const lines: string[] = [];
  for (const d of diagnostics) {
    const loc = d.span ? ` (${d.span.location})` : '';
    const firstLine = d.message.split(/\r?\n/, 1)[0] ?? d.message;
    lines.push(`  [${d.severity.toUpperCase()} ${d.code}]${loc} ${firstLine}`);
  }
  return lines;
}

function formatTargetSplit(report: TargetPlacementReport): string {
  const state = report.complete ? 'complete' : 'split';
  return `  ${report.target}: ${report.summary.lowered}/${report.summary.total} lowered (${state})`;
}

function formatPlacementSection(placement: PolicyPlacementSummary): string[] {
  const lines: string[] = [];
  if (placement.firestore) lines.push(formatTargetSplit(placement.firestore));
  if (placement.storage) lines.push(formatTargetSplit(placement.storage));
  if (placement.rtdb) lines.push(formatTargetSplit(placement.rtdb));
  if (placement.functions && placement.functions.length > 0) {
    for (const fn of placement.functions) {
      const fsNote =
        fn.firestoreLowerable === undefined
          ? ''
          : `, firestore=${fn.firestoreLowerable ? 'yes' : 'no'}`;
      lines.push(
        `  function ${fn.name}: ${fn.cost.sourceUnits}/${fn.cost.sourceLimit} units${fsNote}`,
      );
    }
  }
  return lines;
}

export function formatCheckText(report: PolicyCheckReport): string {
  const status = report.ok ? 'OK' : 'FAILED';
  const lines = [
    `pyric policy check: ${status} (${report.file}, kind=${report.kind ?? 'unknown'}, mode=${report.mode})`,
    `  cost: ${report.cost.totalSourceUnits}/${report.cost.expressionLimit} source units`,
  ];
  if (report.standalone.ok) {
    lines.push(
      `  standalone: ${report.standalone.moduleBytes} bytes, exports=[${report.standalone.exports.join(', ')}]`,
    );
  }
  lines.push(...formatPlacementSection(report.placement));
  lines.push(...formatDiagnosticLines(report.diagnostics));
  return `${lines.join('\n')}\n`;
}

export function formatProveText(report: PolicyProveReport): string {
  const status = report.ok ? 'OK' : 'FAILED';
  const lines = [
    `pyric policy prove: ${status} (${report.file}, kind=${report.kind ?? 'unknown'}, mode=${report.mode})`,
    `  scenarios: ${report.scenarios.passed}/${report.scenarios.total} passed`,
    report.fuzz.enabled
      ? `  fuzz: ${report.fuzz.passed}/${report.fuzz.casesRun} passed (seed=${report.fuzz.seed}, divergences=${report.fuzz.divergences.length})`
      : '  fuzz: disabled',
    `  cost: ${report.cost.totalSourceUnits}/${report.cost.expressionLimit} source units`,
  ];
  lines.push(...formatPlacementSection(report.placement));
  for (const ce of report.counterexamples) {
    const label = ce.source === 'scenario' ? `scenario '${ce.name}'` : `fuzz #${ce.caseIndex}`;
    const loc = ce.span ? ` at ${ce.span.location}` : '';
    const req = ce.requirement ? ` [${ce.requirement}${loc}]` : '';
    lines.push(`  counterexample (${label})${req}: ${ce.reason ?? ce.mismatch}`);
  }
  lines.push(...formatDiagnosticLines(report.diagnostics));
  return `${lines.join('\n')}\n`;
}

export function formatEmitText(report: PolicyEmitReport): string {
  const status = report.ok ? (report.dryRun ? 'DRY-RUN OK' : 'OK') : 'FAILED';
  const lines = [
    `pyric policy emit: ${status} (${report.file}, kind=${report.kind ?? 'unknown'}, mode=${report.mode})`,
  ];
  for (const art of report.artifacts) {
    const dest = art.path ?? art.fileName;
    const action = art.written ? 'wrote' : 'planned';
    const note = art.complete === false ? ' [partial]' : '';
    lines.push(`  ${action} ${art.target} (${art.format}): ${dest} (${art.bytes} bytes)${note}`);
  }
  lines.push(...formatDiagnosticLines(report.diagnostics));
  return `${lines.join('\n')}\n`;
}

export function formatUsageErrorText(command: PolicyCommandName | null, message: string): string {
  const prefix = command ? `pyric policy ${command}` : 'pyric policy';
  return `${prefix}: ${message}\n`;
}
