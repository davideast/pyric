/**
 * `pyric verify` — the swap-trust capstone.
 *
 * Replays a captured sandbox session against a ruleset and reports
 * `real-divergence`s: writes that SUCCEEDED at capture time but are denied
 * or changed under the rules you're about to deploy. That's the "will the
 * rules I'm shipping break what I built in the sandbox?" check — the
 * verification half of pyric's "build in sandbox, swap to prod" pitch.
 *
 * The engine is `replay()` from `pyric/sandbox` (shipped). This command is
 * the user-facing wrapper: take a fixture (or a directory of them) +
 * a rules file, replay, classify, exit nonzero on any real divergence.
 *
 *   pyric verify [fixture|dir] [--rules firestore.rules] [--json]
 *
 * With no positional arg it replays the latest `pyric serve` capture at
 * `.pyric/last-session.json`, so the loop is: serve → use your app →
 * `pyric verify`. autoid-alias / time-drift / sentinel-drift divergences are
 * informational (the engine licenses them); only `real-divergence` fails.
 *
 * Everything above the CLI entry is pure/synchronous given its inputs — the
 * same shape as `examples/replay/ci/check-fixtures.ts`, which this promotes
 * from a CI script into a real subcommand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { replay, type Divergence, type SandboxEvent } from 'pyric/sandbox';
import type { ParsedArgs } from './parse-args.js';

/** One captured user journey. Matches the fixture shape produced by serve
 *  capture and `examples/replay/ci/check-fixtures.ts`. */
export interface Fixture {
  description?: string;
  /** Rules at capture time — informational; the replay runs against the
   *  rules file passed to verify. The diff between the two is what surfaces
   *  real divergences. */
  rules: string;
  events: SandboxEvent[];
  state: Record<string, Record<string, unknown>>;
}

export interface FixtureResult {
  name: string;
  description?: string;
  realDivergences: Divergence[];
  /** Non-bug-signal divergences: autoid-alias, time-drift, sentinel-drift. */
  otherDivergences: Divergence[];
  ok: boolean;
}

/** Replay one fixture against `currentRules`, splitting real divergences
 *  (the bug signal) from the licensed/informational ones. */
export function runFixture(name: string, fixture: Fixture, currentRules: string): FixtureResult {
  const { divergences } = replay(fixture.events, currentRules, {}, fixture.state);
  const realDivergences = divergences.filter((d) => d.kind === 'real-divergence');
  const otherDivergences = divergences.filter((d) => d.kind !== 'real-divergence');
  return {
    name,
    ...(fixture.description !== undefined ? { description: fixture.description } : {}),
    realDivergences,
    otherDivergences,
    ok: realDivergences.length === 0,
  };
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

/** Replay every `*.json` fixture in a directory. */
export function checkDirectory(dir: string, currentRules: string): { results: FixtureResult[]; allOk: boolean } {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results = files.map((f) => runFixture(basename(f, '.json'), loadFixture(join(dir, f)), currentRules));
  return { results, allOk: results.every((r) => r.ok) };
}

export function formatResults(results: FixtureResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const marker = r.ok ? '✓' : '✗';
    const desc = r.description ? ` — ${r.description}` : '';
    const summary = r.ok
      ? `${r.otherDivergences.length} informational divergence(s)`
      : `${r.realDivergences.length} real-divergence(s)`;
    lines.push(`${marker} ${r.name}${desc} — ${summary}`);
    // Point at the offending leaf so the failure names its cause.
    for (const d of r.realDivergences) {
      const where = d.kind === 'real-divergence' ? `${d.path}${d.field ? '.' + d.field : ''}` : '';
      const delta = d.kind === 'real-divergence' ? `${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}` : '';
      lines.push(`    ${where}: ${delta}`);
    }
  }
  return lines.join('\n');
}

/** Default capture location written by `pyric serve` (Piece 2). */
export const SERVE_CAPTURE_PATH = '.pyric/last-session.json';

/**
 * CLI entry. `pyric verify [fixture|dir] [--rules <path>] [--json]`.
 * Exit: 0 = no real divergence, 1 = at least one, 2 = usage/missing input.
 */
export async function runVerify(parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const json = parsed.flags.get('json') === true;

  const rulesFlag = parsed.flags.get('rules');
  const rulesPath = resolve(cwd, typeof rulesFlag === 'string' ? rulesFlag : 'firestore.rules');
  if (!existsSync(rulesPath)) {
    process.stderr.write(
      `pyric verify: rules file not found: ${rulesPath}\n` +
        `  Pass --rules <path> to point at the ruleset you're verifying against.\n`,
    );
    return 2;
  }
  const currentRules = readFileSync(rulesPath, 'utf8');

  // No positional → the latest serve capture. A path → that file or dir.
  const target = parsed.positional[0];
  const inputPath = resolve(cwd, target ?? SERVE_CAPTURE_PATH);
  if (!existsSync(inputPath)) {
    if (target) {
      process.stderr.write(`pyric verify: no such fixture or directory: ${inputPath}\n`);
    } else {
      process.stderr.write(
        `pyric verify: no captured session at ${SERVE_CAPTURE_PATH}.\n` +
          `  Run \`pyric serve\`, exercise your app, then \`pyric verify\` — or pass a fixture path.\n`,
      );
    }
    return 2;
  }

  let results: FixtureResult[];
  let allOk: boolean;
  try {
    if (statSync(inputPath).isDirectory()) {
      ({ results, allOk } = checkDirectory(inputPath, currentRules));
      if (results.length === 0) {
        process.stderr.write(`pyric verify: no .json fixtures in ${inputPath}\n`);
        return 2;
      }
    } else {
      const result = runFixture(basename(inputPath, '.json'), loadFixture(inputPath), currentRules);
      results = [result];
      allOk = result.ok;
    }
  } catch (e) {
    process.stderr.write(`pyric verify: failed to replay: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: allOk,
        rulesPath,
        results: results.map((r) => ({
          name: r.name,
          description: r.description,
          ok: r.ok,
          realDivergences: r.realDivergences,
          otherDivergenceCount: r.otherDivergences.length,
        })),
      }) + '\n',
    );
  } else {
    process.stdout.write(formatResults(results) + '\n');
    if (!allOk) {
      const failed = results.filter((r) => !r.ok).length;
      process.stderr.write(
        `\n✗ ${failed} session(s) regressed under ${basename(rulesPath)} — ` +
          `writes that worked in the sandbox would be DENIED by these rules.\n`,
      );
    } else {
      process.stdout.write(`\n✓ all sessions replay cleanly under ${basename(rulesPath)}.\n`);
    }
  }
  return allOk ? 0 : 1;
}
