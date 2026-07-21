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

type ServiceCommandPath = readonly [service: string, artifact: string, operation: string];

interface ServiceCommand {
  path: ServiceCommandPath;
  run: (parsed: ParsedArgs) => Promise<number>;
}

function routeKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export function createServiceCommandRegistry(
  commands: readonly ServiceCommand[],
): ReadonlyMap<string, ServiceCommand> {
  const registry = new Map<string, ServiceCommand>();
  for (const command of commands) {
    const key = routeKey(command.path);
    if (registry.has(key)) {
      throw new Error(`duplicate service command '${command.path.join(' ')}'`);
    }
    registry.set(key, command);
  }
  return registry;
}

const SERVICE_COMMANDS = [
  { path: ['firestore', 'rules', 'lint'], run: runRulesLint },
  { path: ['firestore', 'rules', 'validate'], run: runRulesValidate },
  { path: ['firestore', 'rules', 'simulate'], run: runRulesSimulate },
  { path: ['firestore', 'rules', 'resolve'], run: runRulesResolve },
  { path: ['firestore', 'indexes', 'generate'], run: runFirestoreIndexesGenerate },
  { path: ['storage', 'rules', 'lint'], run: runStorageRulesLint },
  { path: ['storage', 'rules', 'simulate'], run: runStorageRulesSimulate },
  { path: ['database', 'rules', 'lint'], run: runDatabaseRulesLint },
  { path: ['database', 'rules', 'validate'], run: runDatabaseRulesValidate },
  { path: ['database', 'rules', 'simulate'], run: runDatabaseRulesSimulate },
  { path: ['database', 'rules', 'generate'], run: runDatabaseRulesGenerate },
] as const satisfies readonly ServiceCommand[];

const SERVICE_COMMAND_REGISTRY = createServiceCommandRegistry(SERVICE_COMMANDS);
const SERVICES: ReadonlySet<string> = new Set(SERVICE_COMMANDS.map(({ path }) => path[0]));

function invocation(parsed: ParsedArgs): string {
  return [parsed.subcommand, ...parsed.positional].filter(Boolean).join(' ');
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
  const command = SERVICE_COMMAND_REGISTRY.get(routeKey([service, artifact, operation]));
  if (command) {
    return await command.run({
      ...parsed,
      positional: parsed.positional.slice(command.path.length - 1),
    });
  }

  process.stderr.write(`pyric: unknown command '${invocation(parsed)}'.\n`);
  return 1;
}
