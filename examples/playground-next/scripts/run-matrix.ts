#!/usr/bin/env bun
/**
 * Sharded matrix driver for `run-app-build.ts` — wall-clock parallelism
 * with PROCESS-level isolation (workstation-benchmarks.md §3c tooling).
 *
 * Why processes: the harness uses module-singleton stores (zustand,
 * runner, VFS), so in-process concurrent fixtures would share state.
 * Separate `bun` children are fully hermetic, and the NDJSON store's
 * O_APPEND single-write appends keep concurrent records intact.
 *
 * Why this is measurement-safe: sharding changes WALL CLOCK only.
 * Tokens, turns, correctness, and $ are per-run properties unaffected by
 * contention. `durationMs` IS affected (contended latency) — which is
 * fine under the epic's discipline: never gate on duration; if a claim
 * needs clean latency, run that variant with --jobs=1.
 *
 *   bun scripts/run-matrix.ts --jobs=4 --trials=3 \
 *     --endpoint=http://HOST:8080/v1 --model=gpt-oss-120b \
 *     --strategy=react,draft-validate --variant=my-variant --prune
 */
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, 'evals', 'fixtures', 'app-build');
const RUNNER = resolve(HERE, 'run-app-build.ts');

const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const jobs = Math.max(1, Number(flag('jobs') ?? '4') || 4);
const trials = Math.max(1, Number(flag('trials') ?? '3') || 3);
const fixtureFilter = flag('fixture');
// Everything else is passed straight through to run-app-build.
const passthrough = argv.filter(
  (a) => !a.startsWith('--jobs=') && !a.startsWith('--trials=') && !a.startsWith('--fixture='),
);

const fixtureIds = (await readdir(FIXTURES_DIR))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((id) => !fixtureFilter || id === fixtureFilter)
  .sort();
if (fixtureIds.length === 0) throw new Error(`no fixtures matched ${fixtureFilter ?? '(all)'}`);

interface WorkItem {
  trial: number;
  fixture: string;
}
const queue: WorkItem[] = [];
for (let t = 1; t <= trials; t++) for (const fixture of fixtureIds) queue.push({ trial: t, fixture });

console.log(
  `# run-matrix · ${fixtureIds.length} fixtures × ${trials} trials = ${queue.length} shards · jobs=${jobs}`,
);
console.log(`# passthrough: ${passthrough.join(' ')}\n`);

let failures = 0;
const t0 = performance.now();

async function worker(id: number): Promise<void> {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const label = `[t${item.trial}/${item.fixture}]`;
    const started = performance.now();
    const proc = Bun.spawn(
      ['bun', RUNNER, ...passthrough, `--fixture=${item.fixture}`],
      { cwd: HERE + '/..', stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    if (code !== 0) {
      failures += 1;
      console.log(`${label} FAILED (exit ${code}, ${secs}s, worker ${id})`);
      console.log((err || out).split('\n').slice(-6).join('\n'));
    } else {
      // Surface the per-fixture verdict lines, drop the boilerplate.
      const verdicts = out
        .split('\n')
        .filter((l) => /^\[(PASS|FAIL)\]|^   (oracle|app):/.test(l))
        .join('\n     ');
      console.log(`${label} done in ${secs}s (worker ${id})\n     ${verdicts}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, (_, i) => worker(i + 1)));

const mins = ((performance.now() - t0) / 60000).toFixed(1);
console.log(`\n# matrix complete · ${queue.length === 0 ? 'all shards consumed' : 'queue drained'} · ${mins} min · ${failures} failed shard(s)`);
console.log('# view: bun scripts/render-metrics.ts');
if (failures > 0) process.exit(1);
