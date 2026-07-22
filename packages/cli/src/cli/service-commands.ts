import type { ParsedArgs } from './parse-args.js';
import { SERVICE_COMMANDS } from './service-commands.generated.js';

export type ServiceCommandPath = readonly [service: string, artifact: string, operation: string];

export interface ServiceCommand {
  path: ServiceCommandPath;
  run: ServiceCommandHandler;
}

export type ServiceCommandHandler = (parsed: ParsedArgs) => Promise<number>;

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
