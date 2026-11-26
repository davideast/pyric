#!/usr/bin/env bun
// Runs one shard of a package's test suite. `bun test` has no shard option, so
// the files are partitioned here: the sorted list of `*.test.ts` and `*.spec.ts`
// files under the package (the set `bun test` discovers there) is split into
// shards of about equal time, and each shard passes its own files to `bun test`
// explicitly. Every file lands in exactly one shard; the recorded times below
// only decide which one. The package is packages/cli unless `--package` names another.
// With --quarantine, which only CI passes, a failure of quarantined tests
// alone is reported and does not fail the shard (scripts/lib/quarantine).
//
//   bun scripts/ci/test-shard.ts [--package=pyric|rules] --shard=1/2 [--list] [--quarantine] [-- <extra bun test args>]

import { Glob } from 'bun';
import { resolve } from 'node:path';
import { runBunTest } from '../lib/quarantine/run-bun-test.ts';
import { takeQuarantineFlag } from '../lib/quarantine/source.ts';

/** The packages whose suites are sharded, by `--package` name. */
export const shardedPackages = {
  cli: resolve(import.meta.dir, '../../packages/cli'),
  pyric: resolve(import.meta.dir, '../../packages/pyric'),
  rules: resolve(import.meta.dir, '../../packages/rules'),
} as const;

/**
 * Seconds the slowest files took on CI (main run 45730939884, 2026-11-26 for
 * cli; pull request run 42329320713, 2026-11-07 for pyric and rules, moved
 * into packages/rules in #1521). Every other file counts as
 * DEFAULT_FILE_SECONDS. A stale entry only unbalances the shards; it never
 * drops a file from one.
 */
export const slowFiles: Record<keyof typeof shardedPackages, Readonly<Record<string, number>>> = {
  cli: {
    './test/serve/hosted-sqlite.test.ts': 72,
    './test/serve/native-swift-conformance.test.ts': 60,
    './test/guard-inputs/register-preload-worker-gen.test.ts': 52,
    './test/cli/sandbox-command.test.ts': 33,
    './test/register/real-sdk-stop.test.ts': 33,
    './test/register/register-child-worker-guard-matrix.test.ts': 27,
    './test/bridge/five-surface-entrypoint-parity.test.ts': 25,
    './test/cli/local-probe-deadlines.test.ts': 22,
    './test/functions-rtdb/dev.e2e.test.ts': 22,
    './test/remote/reconnect.test.ts': 22,
    './test/functions-http/heartbeat.test.ts': 21,
    './test/register/register-preload-toctou-guards.test.ts': 17,
    './test/register/live-register-stop.test.ts': 16,
    './test/serve/integration.test.ts': 16,
    './test/serve/stalled-host-discovery.test.ts': 15,
    './test/cli/mcp-session-identity-and-parity.test.ts': 14,
    './test/serve/hot-reload-seed.test.ts': 14,
    './test/serve/runtime/chip.test.ts': 14,
    './test/register/register-child.test.ts': 13,
    './test/register/register-worker-bridge-guards.test.ts': 13,
    './eval/test/run.test.ts': 12,
    './test/cli/ledger/i18-hosted-launcher-messages.test.ts': 12,
    './test/cli/sandbox-process-lifecycle.test.ts': 12,
    './test/functions-callable/client-probes.test.ts': 12,
    './test/serve/entries/persist-writer-role.test.ts': 12,
    './test/serve/hosted-runtime-hunt.test.ts': 12,
    './test/serve/vite-plugin-generation.test.ts': 12,
    './test/bridge/surface/methods/in-process-session-state.test.ts': 11,
    './test/register/register-child-beacon-and-rules.test.ts': 11,
    './test/serve/entries/inpage-mcp-peer-election.test.ts': 10,
    './test/serve/vite-plugin-restart.test.ts': 10,
    './test/serve/vite-plugin-storage.test.ts': 10,
    './test/serve/wildcard-advertised-urls.test.ts': 10,
    './test/serve/worker/oracle-captures/rtdb-server-process-and-vite-ssr.test.ts': 10,
    './test/bridge/cli-shutdown.test.ts': 9,
    './test/functions-rtdb/child.integration.test.ts': 9,
    './test/serve/persist.test.ts': 9,
    './test/serve/tmpdir-hygiene.test.ts': 9,
    './test/serve/vite-generation-rules-watch.test.ts': 9,
    './test/serve/vite-plugin-integration.test.ts': 9,
    './test/serve/vite-ssr-app-check.test.ts': 9,
    './test/bridge/surface/functions-runtime.test.ts': 8,
    './test/functions-tasks/child.integration.test.ts': 8,
    './test/register/live-register-refusals.test.ts': 8,
    './test/register/preload-esm-sync-and-bun-child.test.ts': 8,
    './test/serve/bridge-mount.test.ts': 8,
    './test/serve/vite-worker-stop.test.ts': 8,
    './test/bridge/surface/functions-child-runner.test.ts': 7,
    './test/cli/sandbox-launcher-bounds.test.ts': 7,
    './test/functions-http/orphan.test.ts': 7,
    './test/serve/vite-plugin-ai.test.ts': 7,
    './test/serve/vite-plugin-functions.test.ts': 7,
    './eval/test/rederive.test.ts': 6,
    './test/bridge/surface/handlers-functions.test.ts': 6,
    './test/cli/firebase-json.test.ts': 6,
    './test/functions-callable/wire-serving.test.ts': 6,
    './test/functions-firestore/dev.e2e.test.ts': 6,
    './test/functions-rtdb/dev-stop-cleanly.test.ts': 6,
    './test/serve/entries/worker-runtime.test.ts': 6,
    './test/serve/http-keepalive.test.ts': 6,
    './test/serve/loopback-route-security.test.ts': 6,
    './test/serve/repro/recorder-byte-ceiling.test.ts': 6,
    './test/serve/worker/hosted-host-move.test.ts': 6,
    './test/functions-rtdb/unbuilt-source.e2e.test.ts': 5,
    './test/serve/worker/hosted-reconnect-hold.test.ts': 5,
  },
  pyric: {
    './test/rules/rtdb/stdlib/corpus-lock.test.ts': 26,
    './test/firestore/ledger/a14-collection-query-types.test.ts': 7,
    './test/ai/types.test.ts': 6,
    './test/rules/simulator/re2-size-limits.test.ts': 6,
  },
  rules: {
    './test/rtdb/grammar/canonical.test.ts': 67,
    './test/simulator/expression-budget-fixture.test.ts': 60,
    './test/rtdb/rules-diff.test.ts': 43,
    './test/generators/game-rules-limits.test.ts': 38,
    './test/linter/expression-cost.test.ts': 19,
    './test/grammar/source-segments.test.ts': 17,
    './test/rtdb/node-stack.test.ts': 10,
    './test/rtdb/grammar/expression-nesting.test.ts': 8,
    './test/modules/stdlib-cases.test.ts': 5,
  },
};

/** The time an unlisted file counts for: the suites' other files average about 0.3 s. */
export const DEFAULT_FILE_SECONDS = 0.3;

/** Sorted package-relative paths of every test file, as `./path`. */
export function listTests(cwd: string = shardedPackages.cli): string[] {
  const files: string[] = [];
  for (const file of new Glob('**/*.{test,spec}.ts').scanSync({ cwd })) {
    if (file.split('/').includes('node_modules')) continue;
    files.push(`./${file}`);
  }
  return files.sort();
}

/**
 * The files of shard `index` (1-based) out of `total`. Longest first, each file
 * goes to the shard with the least time so far, the lowest index on a tie, so
 * with no recorded times a file goes to the shard named by its index modulo
 * `total`. The shard's files come back in list order.
 */
export function partition(
  files: readonly string[],
  index: number,
  total: number,
  seconds: Readonly<Record<string, number>> = {},
): string[] {
  const time = (file: string): number => seconds[file] ?? DEFAULT_FILE_SECONDS;
  const order = files.map((file, position) => ({ file, position }))
    .sort((a, b) => time(b.file) - time(a.file) || a.position - b.position);
  const load = new Array<number>(total).fill(0);
  const mine = new Set<number>();
  for (const { file, position } of order) {
    const lightest = load.indexOf(Math.min(...load));
    load[lightest]! += time(file);
    if (lightest === index - 1) mine.add(position);
  }
  return files.filter((_, position) => mine.has(position));
}

export function parseShard(spec: string): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  if (!match) throw new Error(`shard must be index/total, received "${spec}"`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`shard index must be between 1 and ${total}, received "${spec}"`);
  }
  return { index, total };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const { quarantine, rest: own } = takeQuarantineFlag(separator === -1 ? args : args.slice(0, separator));
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const spec = own.find((arg) => arg.startsWith('--shard='))?.slice('--shard='.length) ?? '';
  const { index, total } = parseShard(spec);
  const name = own.find((arg) => arg.startsWith('--package='))?.slice('--package='.length) ?? 'cli';
  const isKnownPackage = Object.hasOwn(shardedPackages, name);
  if (!isKnownPackage) throw new Error(`--package must be one of ${Object.keys(shardedPackages).join(', ')}, received "${name}"`);
  const key = name as keyof typeof shardedPackages;
  const shard = partition(listTests(shardedPackages[key]), index, total, slowFiles[key]);
  if (own.includes('--list')) {
    console.log(shard.join('\n'));
  } else {
    console.log(`${name} test shard ${index}/${total}: ${shard.length} files`);
    process.exit(await runBunTest({ cwd: shardedPackages[key], args: [...passthrough, ...shard], suite: `${name}-${index}`, quarantine }));
  }
}
