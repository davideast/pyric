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
  const command = entry.playwright
    ? ['node_modules/@playwright/test/cli.js', 'test', '--config=packages/cli/test/e2e/hosted/playwright.config.ts', ...entry.tests]
    : ['test', ...entry.tests];
  if (entry.filter) command.push(entry.playwright ? '--grep' : '-t', entry.filter);
  const env = { ...process.env };
  if (entry.node) env.PYRIC_TEST_NODE = env.PYRIC_TEST_NODE ?? 'node';
  const result = spawnSync(entry.playwright ? 'node' : 'bun', command, { encoding: 'utf8', env, timeout: 300_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const passMatch = output.match(/(\d+) pass/);
  const failMatch = output.match(/(\d+) fail/);
  const passes = passMatch ? Number(passMatch[1]) : 0;
  const failures = failMatch ? Number(failMatch[1]) : 0;
  const ok = result.status === 0 && failures === 0 && passes > 0;
  if (!ok) failed = true;
  const summary = ok ? 'PASS' : 'FAIL';
  console.log(`${id}\t${summary}\t${passes} pass, ${failures} fail\t${commit}${dirty ? ' (dirty tree)' : ''}\t${entry.tests.join(' ')}${entry.filter ? ` -t "${entry.filter}"` : ''}`);
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
