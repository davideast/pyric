/**
 * `pyric policy emit <file|->`: compile and emit native Firestore, Storage,
 * and/or RTDB rules alongside a standalone zero-dependency ES module in one
 * command. All outputs are validated in memory before any file is written.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ParsedArgs } from '../parse-args.js';
import { analyzePolicySource, writeReport } from './check.js';
import { makeSimpleDiagnostic } from './diagnostics.js';
import {
  stageArtifact,
  stageFunctionTarget,
  stageTransitionTarget,
  type StagedArtifact,
} from './emit-targets.js';
import { formatEmitText, formatJson } from './format.js';
import {
  defaultOutputStem,
  loadPolicyInputs,
  PolicyInputError,
  type LoadedPolicyInputs,
} from './input.js';
import { loadPolicyExperimentalApi, verifyStandaloneModuleEsm } from './loader.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_STATIC,
  type EmittedArtifact,
  type PolicyCliDeps,
  type PolicyCliDiagnostic,
  type PolicyEmitReport,
  type PolicyExitCode,
  type PolicyProgramKind,
  type PolicyTarget,
  type StandaloneSummary,
} from './types.js';

function resolveTargets(inputs: LoadedPolicyInputs): PolicyTarget[] {
  let list: PolicyTarget[];
  if (inputs.targets !== undefined) {
    list = [...inputs.targets];
  } else {
    list = ['standalone'];
    if (inputs.firestoreBindings !== undefined || inputs.firestoreTemplate !== undefined) {
      list.push('firestore');
    }
    if (inputs.storageBindings !== undefined || inputs.storageTemplate !== undefined) {
      list.push('storage');
    }
    if (inputs.rtdbBindings !== undefined) {
      list.push('rtdb');
    }
  }
  if (inputs.noStandalone) {
    list = list.filter((t) => t !== 'standalone');
  }
  if (list.length === 0) {
    throw new PolicyInputError('no emission targets selected (check --targets and --no-standalone)');
  }
  return list;
}

function assertRequiredTargetInputs(
  kind: PolicyProgramKind,
  targets: readonly PolicyTarget[],
  inputs: LoadedPolicyInputs,
): void {
  for (const target of targets) {
    if (kind === 'transition') {
      if (
        target === 'firestore' &&
        inputs.firestoreBindings === undefined &&
        inputs.firestoreTemplate === undefined
      ) {
        throw new PolicyInputError(
          'firestore target for transition policy requires --firestore-bindings or --firestore-template',
        );
      }
      if (
        target === 'storage' &&
        inputs.storageBindings === undefined &&
        inputs.storageTemplate === undefined
      ) {
        throw new PolicyInputError(
          'storage target for transition policy requires --storage-bindings or --storage-template',
        );
      }
      if (target === 'rtdb' && inputs.rtdbBindings === undefined) {
        throw new PolicyInputError('rtdb target for transition policy requires --rtdb-bindings');
      }
    } else if (kind === 'function' && target === 'rtdb' && inputs.rtdbBindings === undefined) {
      throw new PolicyInputError('rtdb target for function policy requires --rtdb-bindings');
    }
  }
}

export async function runPolicyEmit(
  parsed: ParsedArgs,
  deps: PolicyCliDeps = {},
): Promise<number> {
  const inputs = await loadPolicyInputs('emit', parsed, deps);
  const targets = resolveTargets(inputs);
  if (!inputs.noWrite && inputs.outDir === undefined) {
    throw new PolicyInputError('missing required --out-dir <dir> (or pass --no-write for dry run)');
  }

  const api = await (deps.loadPolicyApi ?? loadPolicyExperimentalApi)();
  const analysis = analyzePolicySource(api, inputs.source, {
    kind: inputs.kind,
    expressionLimit: inputs.expressionLimit,
    firestoreBindings: inputs.firestoreBindings,
    storageBindings: inputs.storageBindings,
    rtdbBindings: inputs.rtdbBindings,
  });

  if (!analysis.staticCheck.ok) {
    const report: PolicyEmitReport = {
      schema: 'pyric.policy.emit.v1',
      command: 'emit',
      ok: false,
      exitCode: POLICY_EXIT_STATIC,
      file: inputs.file,
      kind: analysis.kind,
      mode: inputs.mode,
      name: inputs.name ?? null,
      outDir: inputs.outDir ?? null,
      dryRun: inputs.noWrite,
      targets,
      manifestPath: inputs.manifestPath ?? null,
      staticCheck: analysis.staticCheck,
      diagnostics: analysis.diagnostics,
      standalone: { ...analysis.standalone, esmVerified: false },
      placement: analysis.placement,
      cost: analysis.cost,
      artifacts: [],
    };
    writeReport(inputs.json, report, formatEmitText(report), deps);
    return POLICY_EXIT_STATIC;
  }

  assertRequiredTargetInputs(analysis.kind, targets, inputs);

  const preferredName =
    analysis.staticCheck.transitionName ??
    (analysis.kind === 'function' ? analysis.staticCheck.functions[0] : null);
  const stem = inputs.name ?? defaultOutputStem(inputs.file, preferredName);

  const diagnostics: PolicyCliDiagnostic[] = [...analysis.diagnostics];
  const staged: StagedArtifact[] = [];
  let esmVerified = false;
  let standaloneError = analysis.standalone.error;

  for (const target of targets) {
    if (target === 'standalone') {
      if (!analysis.standalone.ok || analysis.standaloneSource === undefined) continue;
      if (inputs.verifyEsm) {
        try {
          await (deps.verifyStandaloneEsm ?? verifyStandaloneModuleEsm)(
            analysis.standaloneSource,
            analysis.standalone.exports,
          );
          esmVerified = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          standaloneError = message;
          diagnostics.push(
            makeSimpleDiagnostic('STANDALONE_EMIT_ERROR', 'standalone', message, {
              target: 'standalone',
            }),
          );
          continue;
        }
      }
      staged.push(
        stageArtifact(inputs.outDir, 'standalone', 'esm', `${stem}.mjs`, analysis.standaloneSource, {
          exports: analysis.standalone.exports,
        }),
      );
      continue;
    }

    if (analysis.kind === 'module') {
      diagnostics.push(
        makeSimpleDiagnostic(
          'TARGET_LOWERING_ERROR',
          'emit',
          `${target} target is not supported for module policies (emit standalone instead)`,
          { target },
        ),
      );
    } else if (analysis.kind === 'function') {
      stageFunctionTarget(target, stem, inputs, analysis, staged, diagnostics);
    } else {
      stageTransitionTarget(target, stem, api, inputs, analysis, staged, diagnostics);
    }
  }

  const includesStandalone = targets.includes('standalone');
  const standalone: StandaloneSummary = {
    ok: analysis.standalone.ok && (!includesStandalone || !inputs.verifyEsm || esmVerified),
    exports: analysis.standalone.exports,
    moduleBytes: analysis.standalone.moduleBytes,
    ...(includesStandalone ? { esmVerified } : {}),
    ...(standaloneError !== undefined ? { error: standaloneError } : {}),
  };

  const hasError = diagnostics.some((d) => d.severity === 'error');
  const exitCode: PolicyExitCode = hasError ? POLICY_EXIT_PLACEMENT : POLICY_EXIT_OK;
  const shouldWrite = !hasError && !inputs.noWrite;

  if (shouldWrite && inputs.outDir !== undefined && staged.length > 0) {
    const mkdirFn = deps.mkdir ?? mkdir;
    const writeFileFn = deps.writeFile ?? writeFile;
    try {
      await mkdirFn(inputs.outDir, { recursive: true });
      for (const item of staged) {
        if (item.meta.path !== null) {
          await writeFileFn(item.meta.path, item.content, 'utf8');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PolicyInputError(`failed to write emitted artifact: ${message}`, 'io');
    }
  }

  const artifacts: EmittedArtifact[] = hasError
    ? []
    : staged.map((item) => ({
        ...item.meta,
        written: shouldWrite && item.meta.path !== null,
      }));

  const report: PolicyEmitReport = {
    schema: 'pyric.policy.emit.v1',
    command: 'emit',
    ok: exitCode === POLICY_EXIT_OK,
    exitCode,
    file: inputs.file,
    kind: analysis.kind,
    mode: inputs.mode,
    name: stem,
    outDir: inputs.outDir ?? null,
    dryRun: inputs.noWrite,
    targets,
    manifestPath: inputs.manifestPath ?? null,
    staticCheck: analysis.staticCheck,
    diagnostics,
    standalone,
    placement: analysis.placement,
    cost: analysis.cost,
    artifacts,
  };

  if (shouldWrite && inputs.manifestPath !== undefined) {
    const mkdirFn = deps.mkdir ?? mkdir;
    const writeFileFn = deps.writeFile ?? writeFile;
    try {
      await mkdirFn(dirname(inputs.manifestPath), { recursive: true });
      await writeFileFn(inputs.manifestPath, formatJson(report), 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PolicyInputError(
        `failed to write manifest '${inputs.manifestPath}': ${message}`,
        'io',
      );
    }
  }

  writeReport(inputs.json, report, formatEmitText(report), deps);
  return exitCode;
}
