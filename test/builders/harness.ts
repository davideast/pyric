#!/usr/bin/env bun
/**
 * The app-builder harness. Dev tooling only: nothing here runs on pull
 * requests, and no builder app enters CI. See test/builders/README.md.
 *
 *   bun test/builders/harness.ts <command> [options]
 *
 * Commands:
 *   canary [--build] [--packages <dir>]
 *       The scripted builder: installs the packed packages into a scratch app,
 *       plants requests to Google hosts from Node, from the harness browser
 *       and from Bun and curl inside the run's sandbox, and exits
 *       non-zero if a recorder misses one or one succeeds. Run it before
 *       every round.
 *
 * Every command refuses to run (exit 2) where the sandbox is
 * unavailable; there is no fallback without it.
 */
import { runCanary } from './canary/canary.ts';
import { NamespaceUnavailable } from './namespace.ts';

interface Command {
  usage: string;
  run(args: readonly string[]): Promise<number>;
}

class UsageError extends Error {}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} takes a value`);
  return value;
}

function rejectUnknownFlags(args: readonly string[], known: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith('--') && !known.includes(arg));
  if (unknown.length > 0) throw new UsageError(`unknown option: ${unknown.join(', ')}`);
}

/** Each command, by name. The round, run, reproduce and measure commands join this table. */
const COMMANDS: Record<string, Command> = {
  canary: {
    usage: 'canary [--build] [--packages <dir>]',
    async run(args) {
      rejectUnknownFlags(args, ['--build', '--packages']);
      const passed = await runCanary({ build: args.includes('--build'), packages: flagValue(args, '--packages') });
      return passed ? 0 : 1;
    },
  },
};

function usage(): string {
  const lines = Object.values(COMMANDS).map((command) => `  bun test/builders/harness.ts ${command.usage}`);
  return `usage:\n${lines.join('\n')}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined) {
    console.error(name === undefined ? usage() : `unknown command: ${name}\n${usage()}`);
    return 2;
  }
  try {
    return await command.run(args);
  } catch (error) {
    if (error instanceof NamespaceUnavailable) {
      console.error(`refusing to run: ${error.message}`);
      return 2;
    }
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${usage()}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
