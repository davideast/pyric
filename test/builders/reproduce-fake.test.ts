// `reproduce` end to end, no model and no spend: a round with the fake
// builder (fixtures/fake-builder.mjs) and one model, then the real harness
// command on its kept run, each try in its own sandbox with the packed
// packages installed into a fresh copy of the builder's app. Like the round
// test, it runs only when PYRIC_BUILDERS_PACKAGES names the tarballs:
//
//   PYRIC_BUILDERS_PACKAGES=dist/packages bun test ./test/builders/reproduce-fake.test.ts
//
// Scratch and run data go to a temporary directory, never ~/pyric-builders
// or pyric-ops.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TryRecord } from './reproduce.ts';

const PACKAGES = process.env.PYRIC_BUILDERS_PACKAGES;
const REPO_ROOT = resolve(import.meta.dir, '../..');
const TIMEOUT_MS = 1_800_000;
const RUN = 'fake-1-fake-haiku';

function harness(root: string, args: string[]) {
  const env = { ...process.env, PYRIC_BUILDERS_DIR: join(root, 'scratch'), PYRIC_BUILDERS_DATA_DIR: join(root, 'data') };
  const result = spawnSync(process.execPath, ['test/builders/harness.ts', ...args], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: TIMEOUT_MS });
  console.log(result.stdout, result.stderr);
  return result;
}

const packages = () => ['--packages', resolve(PACKAGES ?? '')];

function reproduce(root: string, problem: string, script: string, extra: string[] = []) {
  return harness(root, ['reproduce', 'fake', RUN, problem, '--script', `test/builders/fixtures/repros/${script}`, '--minutes', '2', ...packages(), ...extra]);
}

interface KeptRepro {
  problem: string;
  result: string;
  tries: TryRecord[];
}

function keptRepro(root: string, slug: string): { dir: string; repro: KeptRepro } {
  const base = join(root, 'data', 'runs', 'fake', RUN, 'repros', slug);
  const [stamp] = readdirSync(base);
  const dir = join(base, stamp ?? '');
  return { dir, repro: JSON.parse(readFileSync(join(dir, 'repro.json'), 'utf8')) as KeptRepro };
}

describe.skipIf(PACKAGES === undefined)('reproduce with the fake builder\'s run', () => {
  test('lists the run\'s problems, reproduces the planted ones in a sandbox, and leaves one unconfirmed after two tries', () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-reproduce-'));
    const round = harness(root, ['round', 'fake', '--builder', 'test/builders/fixtures/fake-builder.mjs', '--briefs', 'test/builders/fixtures/briefs', '--models', 'fake-haiku', '--max-budget-usd', '0.01', '--max-round-usd', '0.01', ...packages()]);
    expect(round.status).toBe(0);

    const list = harness(root, ['reproduce', 'fake', RUN, '--list']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('fake-1\tbuilder problem');
    expect(list.stdout).toContain('refusal-allowed-1\t');
    expect(list.stdout).toContain('google-host:firestore.googleapis.com\t');

    const unknown = reproduce(root, 'fake-2', 'behaves.mjs');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('has no problem "fake-2"');

    const planted = reproduce(root, 'fake-1', 'planted-shows.mjs', ['--expect', 'planted problem shows']);
    expect(planted.status).toBe(0);
    const shown = keptRepro(root, 'fake-1');
    expect(shown.repro.result).toBe('reproduced');
    expect(shown.repro.tries.map((entry) => entry.outcome)).toEqual(['reproduced']);
    expect(readFileSync(join(shown.dir, 'try-1', 'logs', 'repro.log'), 'utf8')).toContain('installed @pyric/cli@');
    expect(readdirSync(shown.dir).sort()).toEqual(['repro.json', 'script.mjs', 'try-1']);

    const host = reproduce(root, 'google-host:firestore.googleapis.com', 'firestore-host.mjs');
    expect(host.status).toBe(0);
    const reached = keptRepro(root, 'google-host-firestore-googleapis-com');
    expect(reached.repro.tries[0]?.googleHosts).toContain('firestore.googleapis.com');
    expect(readFileSync(join(reached.dir, 'try-1', 'logs', 'repro.log'), 'utf8')).toContain('fetch failed: PYRIC_BUILDER_REFUSED');
    const network = readFileSync(join(reached.dir, 'try-1', 'network.jsonl'), 'utf8');
    expect(network).toContain('"host":"firestore.googleapis.com"');
    expect(network).not.toContain('"layer":"model-channel"');

    const browser = reproduce(root, 'google-host:firebasestorage.googleapis.com', 'browser-storage-host.mjs');
    expect(browser.status).toBe(0);
    const fromPage = keptRepro(root, 'google-host-firebasestorage-googleapis-com');
    expect(readFileSync(join(fromPage.dir, 'try-1', 'logs', 'repro.log'), 'utf8')).toContain('browser fetch failed');
    expect(readFileSync(join(fromPage.dir, 'try-1', 'network.jsonl'), 'utf8')).toMatch(/"layer":"browser"[^\n]*firebasestorage\.googleapis\.com/);

    const behaves = reproduce(root, 'refusal-allowed-1', 'behaves.mjs');
    expect(behaves.status).toBe(1);
    const unconfirmed = keptRepro(root, 'refusal-allowed-1');
    expect(unconfirmed.repro.result).toBe('unconfirmed');
    expect(unconfirmed.repro.tries.map((entry) => `${entry.attempt} ${entry.outcome}`)).toEqual(['1 not-reproduced', '2 not-reproduced']);
    expect(new Set(unconfirmed.repro.tries.map((entry) => entry.scratch)).size).toBe(2);
  }, TIMEOUT_MS);
});
