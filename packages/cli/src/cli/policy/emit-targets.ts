/**
 * Target-specific in-memory artifact staging helpers for `pyric policy emit`.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { compileLimitViolations, parseToAST } from 'pyric/rules/internal';
import type { PolicyAnalysisResult } from './check.js';
import { makeSimpleDiagnostic } from './diagnostics.js';
import type { LoadedPolicyInputs } from './input.js';
import type {
  EmittedArtifact,
  EmittedArtifactFormat,
  PolicyCliDiagnostic,
  PolicyExperimentalApi,
  PolicyTarget,
  TargetPlacementReport,
} from './types.js';

export interface StagedArtifact {
  readonly meta: Omit<EmittedArtifact, 'written'>;
  readonly content: string;
}

const FIRESTORE_MODULE_RESERVED = new Set([
  'get',
  'getAfter',
  'exists',
  'existsAfter',
  'debug',
  'int',
  'float',
  'string',
  'bool',
  'bytes',
  'path',
  'latlng',
  'duration',
  'timestamp',
  'math',
  'hashing',
  'rules',
]);

const MAX_FIRESTORE_SOURCE_BYTES = 256 * 1024;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

export function stageArtifact(
  outDir: string | undefined,
  target: PolicyTarget,
  format: EmittedArtifactFormat,
  fileName: string,
  rawContent: string,
  extra: Partial<
    Omit<EmittedArtifact, 'target' | 'format' | 'fileName' | 'path' | 'written' | 'bytes' | 'sha256'>
  > = {},
): StagedArtifact {
  const content = ensureTrailingNewline(rawContent);
  return {
    content,
    meta: {
      target,
      format,
      fileName,
      path: outDir !== undefined ? join(outDir, fileName) : null,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
      ...extra,
    },
  };
}

function collectInvalidIdentifiers(node: unknown, bad: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectInvalidIdentifiers(item, bad);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (rec.type === 'identifier' && typeof rec.name === 'string') {
    if (rec.name !== 'resource' && rec.name !== 'request') bad.add(rec.name);
    return;
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') collectInvalidIdentifiers(val, bad);
  }
}

function emitPartialFirestoreModule(name: string, predicates: readonly string[]): string {
  if (FIRESTORE_MODULE_RESERVED.has(name)) {
    throw new Error(`Module export conflicts with Firestore builtin: ${name}`);
  }
  const body =
    predicates.length === 1
      ? predicates[0]!
      : predicates.map((p) => `(${p})`).join('\n    && ');
  const fn = `function ${name}() {\n  return ${body};\n}`;
  const source = `rules_version = '2+modules';\n\nexport ${fn}\n`;
  if (Buffer.byteLength(source, 'utf8') > MAX_FIRESTORE_SOURCE_BYTES) {
    throw new Error(`${name}: emitted Firestore module exceeds 256 KiB source limit`);
  }
  const wrapped = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{db}/documents {',
    `    ${fn}`,
    `    match /items/{id} { allow update: if ${name}(); }`,
    '  }',
    '}',
  ].join('\n');
  const ast = parseToAST(wrapped);
  if (!ast) throw new Error(`${name}: generated partial Firestore module failed to parse`);
  const violations = compileLimitViolations(ast);
  if (violations.length > 0) {
    throw new Error(`${name}: ${violations.map((v) => v.message).join(', ')}`);
  }
  const badIds = new Set<string>();
  const fnAst = ast.service.match.functions[0];
  if (fnAst) collectInvalidIdentifiers(fnAst.body, badIds);
  if (badIds.size > 0) {
    throw new Error(
      `${name}: identifier(s) not in scope in a zero-argument Firestore module helper: ${[...badIds].join(', ')}`,
    );
  }
  return source;
}

function buildRtdbRulesDocument(
  rtdbPath: string | undefined,
  predicate: string,
): { rules: Record<string, unknown> } {
  const leaf: Record<string, unknown> = { '.validate': predicate };
  if (rtdbPath === undefined) return { rules: leaf };
  const parts = rtdbPath.split('/').slice(1);
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (i === parts.length - 1) {
      cursor[part] = leaf;
    } else {
      const next: Record<string, unknown> = {};
      cursor[part] = next;
      cursor = next;
    }
  }
  return { rules: root };
}

function pushResidualErrors(
  diagnostics: PolicyCliDiagnostic[],
  report: TargetPlacementReport,
): void {
  for (const row of report.rows) {
    if (row.lowered) continue;
    const detail = row.completeReason ?? row.reason;
    diagnostics.push(
      makeSimpleDiagnostic(
        'TARGET_LOWERING_ERROR',
        'emit',
        `${report.target} residual requirement '${row.requirement}': ${detail}`,
        { span: row.span, target: report.target, requirement: row.requirement },
      ),
    );
  }
}

export function stageFunctionTarget(
  target: Exclude<PolicyTarget, 'standalone'>,
  stem: string,
  inputs: LoadedPolicyInputs,
  analysis: PolicyAnalysisResult,
  staged: StagedArtifact[],
  diagnostics: PolicyCliDiagnostic[],
): void {
  const fn = analysis.compiledFunction!;
  if (target === 'firestore') {
    try {
      staged.push(
        stageArtifact(inputs.outDir, 'firestore', 'firestore-module', `${stem}.firestore.rules`, fn.firestoreModule(), {
          complete: true,
        }),
      );
    } catch (err) {
      diagnostics.push(
        makeSimpleDiagnostic('TARGET_LOWERING_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
          target: 'firestore',
        }),
      );
    }
    return;
  }
  if (target === 'rtdb') {
    try {
      const predicate = fn.rtdbPredicate(inputs.rtdbBindings!);
      const doc = buildRtdbRulesDocument(inputs.rtdbPath, predicate);
      staged.push(
        stageArtifact(
          inputs.outDir,
          'rtdb',
          'rtdb-rules-json',
          `${stem}.rtdb.rules.json`,
          JSON.stringify(doc, null, 2),
          {
            complete: true,
            predicate,
            ...(inputs.rtdbPath !== undefined ? { rtdbPath: inputs.rtdbPath } : {}),
          },
        ),
      );
    } catch (err) {
      diagnostics.push(
        makeSimpleDiagnostic('TARGET_LOWERING_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
          target: 'rtdb',
        }),
      );
    }
    return;
  }
  diagnostics.push(
    makeSimpleDiagnostic('TARGET_LOWERING_ERROR', 'emit', 'storage target is only supported for transition policies', {
      target: 'storage',
    }),
  );
}

function stageRulesModuleTarget(params: {
  target: 'firestore' | 'storage';
  fileName: string;
  outDir: string | undefined;
  mode: LoadedPolicyInputs['mode'];
  report: TargetPlacementReport;
  emitComplete: () => string;
  emitPartial: (rows: TargetPlacementReport['rows']) => string;
  staged: StagedArtifact[];
  diagnostics: PolicyCliDiagnostic[];
}): void {
  const { target, fileName, outDir, mode, report, staged, diagnostics } = params;
  const format: EmittedArtifactFormat = target === 'firestore' ? 'firestore-module' : 'storage-module';
  if (report.complete) {
    try {
      staged.push(
        stageArtifact(outDir, target, format, fileName, params.emitComplete(), {
          complete: true,
          loweredRequirements: report.summary.loweredRequirements,
          residualRequirements: [],
        }),
      );
    } catch (err) {
      diagnostics.push(
        makeSimpleDiagnostic('TARGET_LOWERING_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
          target,
        }),
      );
    }
    return;
  }
  if (mode === 'complete') {
    pushResidualErrors(diagnostics, report);
    return;
  }
  const withPred = report.rows.filter((r) => r.predicate !== undefined);
  if (withPred.length === 0) {
    diagnostics.push(
      makeSimpleDiagnostic(
        'TARGET_SKIPPED',
        'emit',
        `${target} mixed-mode emission skipped: no requirements lowered to target predicates`,
        { severity: 'warning', target },
      ),
    );
    return;
  }
  try {
    staged.push(
      stageArtifact(outDir, target, format, fileName, params.emitPartial(withPred), {
        complete: false,
        loweredRequirements: withPred.map((r) => r.requirement),
        residualRequirements: report.summary.residualRequirements,
      }),
    );
  } catch (err) {
    diagnostics.push(
      makeSimpleDiagnostic('TARGET_LOWERING_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
        target,
      }),
    );
  }
}

export function stageTransitionTarget(
  target: Exclude<PolicyTarget, 'standalone'>,
  stem: string,
  api: PolicyExperimentalApi,
  inputs: LoadedPolicyInputs,
  analysis: PolicyAnalysisResult,
  staged: StagedArtifact[],
  diagnostics: PolicyCliDiagnostic[],
): void {
  const policy = analysis.compiledPolicy!;
  const transitionName = analysis.staticCheck.transitionName!;

  if (target === 'firestore') {
    const hasTemplate = inputs.firestoreTemplate !== undefined;
    if (hasTemplate) {
      try {
        const composed = policy.bind.firestore(inputs.firestoreTemplate!);
        staged.push(
          stageArtifact(inputs.outDir, 'firestore', 'firestore-rules', `${stem}.firestore.rules`, composed.rules, {
            complete: true,
          }),
        );
      } catch (err) {
        diagnostics.push(
          makeSimpleDiagnostic('TEMPLATE_COMPOSE_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
            target: 'firestore',
          }),
        );
      }
    }
    if (inputs.firestoreBindings !== undefined) {
      const bindings = inputs.firestoreBindings;
      stageRulesModuleTarget({
        target: 'firestore',
        fileName: hasTemplate ? `${stem}.firestore.module.rules` : `${stem}.firestore.rules`,
        outDir: inputs.outDir,
        mode: inputs.mode,
        report: analysis.placement.firestore!,
        emitComplete: () => policy.firestoreModule(bindings),
        emitPartial: (rows) => emitPartialFirestoreModule(transitionName, rows.map((r) => r.predicate!)),
        staged,
        diagnostics,
      });
    }
    return;
  }

  if (target === 'storage') {
    const hasTemplate = inputs.storageTemplate !== undefined;
    if (hasTemplate) {
      try {
        const composed = policy.bind.storage(inputs.storageTemplate!);
        staged.push(
          stageArtifact(inputs.outDir, 'storage', 'storage-rules', `${stem}.storage.rules`, composed.rules, {
            complete: true,
          }),
        );
      } catch (err) {
        diagnostics.push(
          makeSimpleDiagnostic('TEMPLATE_COMPOSE_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
            target: 'storage',
          }),
        );
      }
    }
    if (inputs.storageBindings !== undefined) {
      const bindings = inputs.storageBindings;
      stageRulesModuleTarget({
        target: 'storage',
        fileName: hasTemplate ? `${stem}.storage.module.rules` : `${stem}.storage.rules`,
        outDir: inputs.outDir,
        mode: inputs.mode,
        report: analysis.placement.storage!,
        emitComplete: () => policy.storageModule(bindings),
        emitPartial: (rows) =>
          api.emitStorageModule(
            transitionName,
            rows.map((r) => ({ requirement: r.requirement, predicate: r.predicate })),
          ),
        staged,
        diagnostics,
      });
    }
    return;
  }

  const report = analysis.placement.rtdb!;
  if (!report.complete && inputs.mode === 'complete') {
    pushResidualErrors(diagnostics, report);
    return;
  }
  const withPred = report.rows.filter((r) => r.predicate !== undefined);
  if (withPred.length === 0) {
    diagnostics.push(
      makeSimpleDiagnostic(
        'TARGET_SKIPPED',
        'emit',
        'rtdb mixed-mode emission skipped: no requirements lowered to RTDB predicates',
        { severity: 'warning', target: 'rtdb' },
      ),
    );
    return;
  }
  try {
    const predicate =
      withPred.length === 1
        ? withPred[0]!.predicate!
        : withPred.map((r) => `(${r.predicate!})`).join(' && ');
    const doc = buildRtdbRulesDocument(inputs.rtdbPath, predicate);
    if (inputs.rtdbPath !== undefined) {
      policy.bind
        .rtdb({ path: inputs.rtdbPath, bindings: inputs.rtdbBindings!, mode: inputs.mode })
        .verify(doc);
    }
    staged.push(
      stageArtifact(
        inputs.outDir,
        'rtdb',
        'rtdb-rules-json',
        `${stem}.rtdb.rules.json`,
        JSON.stringify(doc, null, 2),
        {
          complete: report.complete,
          loweredRequirements: report.summary.loweredRequirements,
          residualRequirements: report.summary.residualRequirements,
          predicate,
          ...(inputs.rtdbPath !== undefined ? { rtdbPath: inputs.rtdbPath } : {}),
        },
      ),
    );
  } catch (err) {
    diagnostics.push(
      makeSimpleDiagnostic('TARGET_LOWERING_ERROR', 'emit', err instanceof Error ? err.message : String(err), {
        target: 'rtdb',
      }),
    );
  }
}
