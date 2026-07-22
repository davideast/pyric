import { readdirSync } from 'node:fs';
import type { ParsedArgs } from './parse-args.js';

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

async function loadServiceCommands(): Promise<readonly ServiceCommand[]> {
  const directory = new URL('./service-command-records/', import.meta.url);
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(extension) && !file.endsWith('.d.ts'))
    .sort();
  return await Promise.all(files.map(async (file) => {
    const module = await import(new URL(file, directory).href) as { default: ServiceCommand };
    return module.default;
  }));
}

const serviceCommands = loadServiceCommands().then((commands) => ({
  registry: createServiceCommandRegistry(commands),
  services: new Set(commands.map(({ path }) => path[0])),
}));

function invocation(parsed: ParsedArgs): string {
  return [parsed.subcommand, ...parsed.positional].filter(Boolean).join(' ');
}

/**
 * Dispatch the `pyric <service> <artifact> <operation>` command family.
 * Returns `null` when the first token is not a service command so the
 * top-level dispatcher can continue with commands such as `dev` and `verify`.
 */
export async function dispatchServiceCommand(parsed: ParsedArgs): Promise<number | null> {
  const { registry, services } = await serviceCommands;
  const service = parsed.subcommand;
  if (!service || !services.has(service)) return null;

  const [artifact, operation] = parsed.positional;
  const command = registry.get(routeKey([service, artifact, operation]));
  if (command) {
    return await command.run({
      ...parsed,
      positional: parsed.positional.slice(command.path.length - 1),
    });
  }

  process.stderr.write(`pyric: unknown command '${invocation(parsed)}'.\n`);
  return 1;
}
