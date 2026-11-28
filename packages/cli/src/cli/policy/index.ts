/**
 * Top-level dispatcher for `pyric policy <check|prove|emit>`.
 */
import type { ParsedArgs } from '../parse-args.js';
import { runPolicyCheck } from './check.js';
import { makeSimpleDiagnostic } from './diagnostics.js';
import { runPolicyEmit } from './emit.js';
import { formatJson, formatUsageErrorText, renderPolicyHelp } from './format.js';
import { isJsonOutput, PolicyInputError, readBooleanFlag } from './input.js';
import { runPolicyProve } from './prove.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_USAGE,
  type PolicyCliDeps,
  type PolicyCommandName,
  type PolicyUsageErrorReport,
} from './types.js';

const SUBCOMMANDS: ReadonlySet<string> = new Set(['check', 'prove', 'emit']);

function writeUsageError(
  command: PolicyCommandName | null,
  file: string | null,
  code: 'USAGE_ERROR' | 'IO_ERROR' | 'LOADER_ERROR',
  stage: 'cli' | 'io',
  message: string,
  json: boolean,
  deps: PolicyCliDeps,
): number {
  if (json) {
    const payload: PolicyUsageErrorReport = {
      schema: command ? `pyric.policy.${command}.v1` : 'pyric.policy.v1',
      command,
      ok: false,
      exitCode: POLICY_EXIT_USAGE,
      file,
      diagnostics: [makeSimpleDiagnostic(code, stage, message)],
    };
    (deps.stdout ?? process.stdout).write(formatJson(payload));
  } else {
    (deps.stderr ?? process.stderr).write(formatUsageErrorText(command, message));
  }
  return POLICY_EXIT_USAGE;
}

export async function runPolicy(
  parsed: ParsedArgs,
  deps: PolicyCliDeps = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const sub = parsed.positional[0];
  const json = isJsonOutput(parsed.flags);
  const asksHelp =
    readBooleanFlag(parsed.flags.get('help')) || readBooleanFlag(parsed.flags.get('h'));

  if (asksHelp) {
    if (sub !== undefined && !SUBCOMMANDS.has(sub)) {
      return writeUsageError(
        null,
        null,
        'USAGE_ERROR',
        'cli',
        `unknown policy subcommand '${sub}'; expected check, prove, or emit`,
        json,
        deps,
      );
    }
    out.write(renderPolicyHelp(sub));
    return POLICY_EXIT_OK;
  }

  if (sub === undefined) {
    if (json) {
      return writeUsageError(
        null,
        null,
        'USAGE_ERROR',
        'cli',
        'missing policy subcommand; expected check, prove, or emit',
        true,
        deps,
      );
    }
    out.write(renderPolicyHelp());
    return POLICY_EXIT_OK;
  }

  if (!SUBCOMMANDS.has(sub)) {
    return writeUsageError(
      null,
      null,
      'USAGE_ERROR',
      'cli',
      `unknown policy subcommand '${sub}'; expected check, prove, or emit`,
      json,
      deps,
    );
  }

  const command = sub as PolicyCommandName;
  const file = parsed.positional[1] ?? null;

  try {
    if (command === 'check') return await runPolicyCheck(parsed, deps);
    if (command === 'prove') return await runPolicyProve(parsed, deps);
    return await runPolicyEmit(parsed, deps);
  } catch (err) {
    if (err instanceof PolicyInputError) {
      const code = err.kind === 'io' ? 'IO_ERROR' : 'USAGE_ERROR';
      const stage = err.kind === 'io' ? 'io' : 'cli';
      return writeUsageError(command, file, code, stage, err.message, json, deps);
    }
    const message = err instanceof Error ? err.message : String(err);
    return writeUsageError(command, file, 'LOADER_ERROR', 'cli', message, json, deps);
  }
}

export { runPolicyCheck } from './check.js';
export { runPolicyProve } from './prove.js';
export { runPolicyEmit } from './emit.js';
export {
  POLICY_EXIT_OK,
  POLICY_EXIT_USAGE,
  POLICY_EXIT_STATIC,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_PROOF,
  type PolicyCheckReport,
  type PolicyProveReport,
  type PolicyEmitReport,
  type PolicyCliDeps,
} from './types.js';
