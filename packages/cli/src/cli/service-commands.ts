import type { ParsedArgs } from './parse-args.js';
import {
  runDatabaseRulesGenerate,
  runDatabaseRulesLint,
  runDatabaseRulesSimulate,
  runDatabaseRulesValidate,
} from './database-rules.js';
import { runFirestoreIndexesGenerate } from './firestore-indexes.js';
import {
  runRulesLint,
  runRulesResolve,
  runRulesSimulate,
  runRulesValidate,
} from './rules.js';
import { runStorageRulesLint, runStorageRulesSimulate } from './storage-rules.js';

const SERVICES = new Set(['firestore', 'storage', 'database']);

function invocation(parsed: ParsedArgs): string {
  return [parsed.subcommand, ...parsed.positional].filter(Boolean).join(' ');
}

function argumentsAfterPath(parsed: ParsedArgs, pathLength: number): ParsedArgs {
  return { ...parsed, positional: parsed.positional.slice(pathLength - 1) };
}

/**
 * Dispatch the `pyric <service> <artifact> <operation>` command family.
 * Returns `null` when the first token is not a service command so the
 * top-level dispatcher can continue with commands such as `dev` and `verify`.
 */
export async function dispatchServiceCommand(parsed: ParsedArgs): Promise<number | null> {
  const service = parsed.subcommand;
  if (!service || !SERVICES.has(service)) return null;

  const [artifact, operation] = parsed.positional;
  if (service === 'firestore' && artifact === 'rules' && operation === 'lint') {
    return await runRulesLint(argumentsAfterPath(parsed, 3));
  }
  if (service === 'firestore' && artifact === 'rules' && operation === 'validate') {
    return await runRulesValidate(argumentsAfterPath(parsed, 3));
  }
  if (service === 'firestore' && artifact === 'rules' && operation === 'simulate') {
    return await runRulesSimulate(argumentsAfterPath(parsed, 3));
  }
  if (service === 'firestore' && artifact === 'rules' && operation === 'resolve') {
    return await runRulesResolve(argumentsAfterPath(parsed, 3));
  }
  if (service === 'firestore' && artifact === 'indexes' && operation === 'generate') {
    return await runFirestoreIndexesGenerate(argumentsAfterPath(parsed, 3));
  }
  if (service === 'storage' && artifact === 'rules' && operation === 'lint') {
    return await runStorageRulesLint(argumentsAfterPath(parsed, 3));
  }
  if (service === 'storage' && artifact === 'rules' && operation === 'simulate') {
    return await runStorageRulesSimulate(argumentsAfterPath(parsed, 3));
  }
  if (service === 'database' && artifact === 'rules' && operation === 'lint') {
    return await runDatabaseRulesLint(argumentsAfterPath(parsed, 3));
  }
  if (service === 'database' && artifact === 'rules' && operation === 'validate') {
    return await runDatabaseRulesValidate(argumentsAfterPath(parsed, 3));
  }
  if (service === 'database' && artifact === 'rules' && operation === 'simulate') {
    return await runDatabaseRulesSimulate(argumentsAfterPath(parsed, 3));
  }
  if (service === 'database' && artifact === 'rules' && operation === 'generate') {
    return await runDatabaseRulesGenerate(argumentsAfterPath(parsed, 3));
  }

  process.stderr.write(`pyric: unknown command '${invocation(parsed)}'.\n`);
  return 1;
}
