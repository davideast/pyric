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
 *   round <round> --models <id,id> --max-budget-usd <usd> --max-round-usd <usd>
 *         [--builder claude|<script>] [--briefs <dir>] [--packages <dir> | --build]
 *         [--concurrency 1|2]
 *       Runs every brief of the round once per model, each builder in its
 *       own sandbox, at the run cap given, under the round cap given.
 *       Neither cap has a default.
 *   measure [--file <measurements.jsonl>] [--runs-per-night <n>] [--json]
 *       Per model: cost per run and per verification, confirmed new findings
 *       per app, the share thrown out, cost per confirmed new finding, and
 *       the nightly model and cap.
 *
 * Every command that runs a builder refuses to run (exit 2) where the
 * sandbox is unavailable; there is no fallback without it.
 */
import { PreflightFailed, runCanary } from './canary/canary.ts';
import { flagValue, rejectUnknownFlags, UsageError } from './cli-args.ts';
import { formatSummary, summarize } from './measure.ts';
import { readMeasurements } from './measurement.ts';
import { NamespaceUnavailable } from './namespace.ts';
import { runRound } from './round.ts';
import { parseRoundOptions } from './round-options.ts';
import { measurementsFile } from './round-paths.ts';

interface Command {
  usage: string;
  run(args: readonly string[]): Promise<number>;
}

function positiveInteger(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${flag} takes a whole number of at least 1, received "${raw}"`);
  return value;
}

/** Each command, by name. The run and reproduce commands join this table. */
const COMMANDS: Record<string, Command> = {
  canary: {
    usage: 'canary [--build] [--packages <dir>]',
    async run(args) {
      rejectUnknownFlags(args, ['--build', '--packages']);
      const packages = flagValue(args, '--packages');
      const passed = await runCanary({ build: args.includes('--build'), ...(packages === undefined ? {} : { packages }) });
      return passed ? 0 : 1;
    },
  },
  round: {
    usage: 'round <round> --models <id,id> --max-budget-usd <usd> --max-round-usd <usd> [--builder claude|<script>] [--briefs <dir>] [--packages <dir> | --build] [--concurrency 1|2]',
    async run(args) {
      const passed = await runRound(parseRoundOptions(args));
      return passed ? 0 : 1;
    },
  },
  measure: {
    usage: 'measure [--file <measurements.jsonl>] [--runs-per-night <n>] [--json]',
    async run(args) {
      rejectUnknownFlags(args, ['--file', '--runs-per-night', '--json']);
      const file = flagValue(args, '--file') ?? measurementsFile();
      const runsPerNight = positiveInteger('--runs-per-night', flagValue(args, '--runs-per-night'));
      const { lines, errors } = readMeasurements(file);
      for (const error of errors) console.error(`${file}: ${error}`);
      const summary = summarize(lines, runsPerNight === undefined ? {} : { runsPerNight });
      console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : formatSummary(summary));
      return errors.length === 0 ? 0 : 1;
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
    if (error instanceof PreflightFailed) {
      console.error(error.message);
      return 2;
    }
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${usage()}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
