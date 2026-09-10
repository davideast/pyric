/**
 * `pyric <tool> <method> --<arg> <value>`: one method record, run from the
 * command line against the project's own headless sandbox.
 *
 * The record is the declaration the MCP tool and this command both derive from,
 * so the CLI cannot drift from the surface: it reads the same schema, runs the
 * same validator, calls the same handler, and persists to the same state file
 * `pyric mcp --headless` reads. The only difference is the transport, and the
 * two things the transport changes are that an object argument arrives as a
 * JSON string, and that any argument may instead be read from a file with
 * `--<arg>-file <path>`.
 */
import { initializeSandbox } from 'pyric/sandbox';
import {
  HEADLESS_STATE_RELATIVE,
  loadProjectRules,
  loadSandboxSnapshot,
  openPersistedServices,
  saveSandboxSnapshot,
} from '../bridge/server/headless.js';
import { loadStorageSidecar, saveStorageSidecar } from '../bridge/server/storage-sidecar.js';
import { createSurfaceContext } from '../bridge/surface/context.js';
import { validateArguments } from '../bridge/surface/method-validation.js';
import { methodByKey } from '../bridge/surface/methods/registry.js';
import type { OperationResult } from '../bridge/surface/types.js';
import { argumentsFromFlags } from './surface-method-args.js';
import { selectAllowProduction } from './mcp-proxy.js';
import type { ParsedArgs } from './parse-args.js';

/** Where output goes. A test supplies its own so it can read what was printed. */
export interface SurfaceMethodDeps {
  cwd?: string;
  stdout?: { write(text: string): void };
  stderr?: { write(text: string): void };
  /** Environment `--allow-production`'s fallback is read from. Defaults to the process. */
  env?: NodeJS.ProcessEnv;
}

/** Exit code for a call the surface refused, distinct from a usage error. */
const CALL_FAILED = 2;
const USAGE_ERROR = 1;

/** Print one result the way every service command prints one. */
function report(
  result: OperationResult,
  stdout: { write(text: string): void },
  json: boolean,
): void {
  if (json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  stdout.write(`${result.summary}\n`);
  if (result.data !== undefined) stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
}

/**
 * Run one method record against the project's sandbox. The sandbox is loaded
 * from `.pyric/state` before the call and written back after it, so a sequence
 * of commands composes the same way a sequence of MCP calls does.
 */
export async function runSurfaceMethod(
  key: string,
  parsed: ParsedArgs,
  deps: SurfaceMethodDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const method = methodByKey(key);
  const allowProduction = selectAllowProduction(parsed, env);

  const read = argumentsFromFlags(method, parsed, cwd);
  if ('error' in read) {
    stderr.write(`pyric: ${read.error}\n`);
    return USAGE_ERROR;
  }

  const sandbox = initializeSandbox();
  const storage = openPersistedServices(sandbox, cwd);
  loadSandboxSnapshot(sandbox, cwd);
  loadProjectRules(sandbox, cwd);
  await loadStorageSidecar(storage, cwd);

  const ctx = createSurfaceContext(sandbox);
  const rejection = validateArguments(method, read.args, allowProduction);
  if (rejection !== null) {
    stderr.write(`pyric: ${rejection.summary}\n`);
    return CALL_FAILED;
  }

  let result: OperationResult;
  try {
    result = await method.handler(read.args, ctx);
  } catch (error) {
    stderr.write(`pyric: ${error instanceof Error ? error.message : String(error)}\n`);
    return CALL_FAILED;
  }

  // A read changes nothing, so it writes nothing back: running `whoami` in a
  // directory must not create a state file there.
  if (result.ok && method.effect !== 'read') {
    saveSandboxSnapshot(sandbox, cwd);
    await saveStorageSidecar(storage, cwd);
  }
  report(result, stdout, parsed.flags.get('json') === true);
  if (!result.ok) {
    stderr.write(`pyric: state in ${HEADLESS_STATE_RELATIVE} is unchanged.\n`);
    return CALL_FAILED;
  }
  return 0;
}
