/**
 * Run the acceptance evidence for one or more ledger items.
 *
 *   bun scripts/verify-ledger.ts A1 A2
 *   bun scripts/verify-ledger.ts --phase 1
 *   bun scripts/verify-ledger.ts --all
 *
 * The map in `scripts/ledger-acceptance.json` names, per item, the test files
 * that prove it and an optional test-name filter. This script runs them with
 * `bun test`, prints one line per item with the current commit, and exits
 * non-zero if any item failed or has no map entry. The printed block is the
 * only accepted form of a fix submission for `docs/hosted-review-ledger.md`.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface Entry {
  phase: number;
  tests: string[];
  filter?: string;
  node?: boolean;
  playwright?: boolean;
  browserTests?: string[];
  playwrightConfig?: string;
  note?: string;
}

const map = JSON.parse(readFileSync(new URL('./ledger-acceptance.json', import.meta.url), 'utf8')) as Record<string, Entry>;
const args = process.argv.slice(2);
const wantsAll = args.includes('--all');
const phaseIndex = args.indexOf('--phase');
const phase = phaseIndex === -1 ? null : Number(args[phaseIndex + 1]);
const isPhaseValue = (index: number) => phaseIndex !== -1 && index === phaseIndex + 1;
const explicit = args.filter((arg, index) => !arg.startsWith('--') && !isPhaseValue(index));

const selected = Object.entries(map).filter(([id, entry]) => {
  if (wantsAll) return true;
  if (phase !== null) return entry.phase === phase;
  return explicit.includes(id);
});
const unknown = explicit.filter((id) => !(id in map));

const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim().length > 0;

let failed = unknown.length > 0;
for (const id of unknown) console.log(`${id}\tNO MAP ENTRY`);

for (const [id, entry] of selected) {
  const config = entry.playwrightConfig ?? 'packages/cli/test/e2e/hosted/playwright.config.ts';
  const groups = [{ tests: entry.tests, playwright: entry.playwright ?? false }];
  if (entry.browserTests) groups.push({ tests: entry.browserTests, playwright: true });
  let output = '';
  let passes = 0;
  let failures = 0;
  let ok = true;
  for (const group of groups) {
    const command = group.playwright
      ? ['node_modules/@playwright/test/cli.js', 'test', `--config=${config}`, ...group.tests]
      : ['test', ...group.tests];
    if (entry.filter) command.push(group.playwright ? '--grep' : '-t', entry.filter);
    const env = { ...process.env };
    if (entry.node) env.PYRIC_TEST_NODE = env.PYRIC_TEST_NODE ?? 'node';
    const result = spawnSync(group.playwright ? 'node' : 'bun', command, { encoding: 'utf8', env, timeout: 300_000 });
    const groupOutput = `${result.stdout}\n${result.stderr}`;
    output += groupOutput;
    const groupPasses = Number(groupOutput.match(/(\d+) pass/)?.[1] ?? 0);
    const groupFailures = Number(groupOutput.match(/(\d+) fail/)?.[1] ?? 0);
    passes += groupPasses;
    failures += groupFailures;
    const groupPassed = result.status === 0 && groupFailures === 0 && groupPasses > 0;
    ok &&= groupPassed;
  }
  if (!ok) failed = true;
  const summary = ok ? 'PASS' : 'FAIL';
  console.log(`${id}\t${summary}\t${passes} pass, ${failures} fail\t${commit}${dirty ? ' (dirty tree)' : ''}\t${[...entry.tests, ...(entry.browserTests ?? [])].join(' ')}${entry.filter ? ` -t "${entry.filter}"` : ''}`);
  if (!ok) {
    const tail = output.trim().split('\n').slice(-25).join('\n');
    console.log(tail.replace(/^/gm, '    '));
  }
}

if (selected.length === 0 && unknown.length === 0) {
  console.log('No items selected. Pass item ids, --phase N, or --all.');
  process.exit(2);
}
process.exit(failed ? 1 : 0);
