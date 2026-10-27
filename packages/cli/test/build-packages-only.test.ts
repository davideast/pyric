import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

const buildScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/build.sh');

// build.sh starts about 30 processes per case (five of them Node), so its wall
// time follows CPU availability rather than any work of its own: 50 to 400 ms
// on an idle CI runner, about 8 s with 64 busy loops sharing two cores, and a
// CI run once took 70 times its idle time (#1277). The script gets its own
// deadline, sized for that, below the test's timeout, so a run that still
// overruns fails with a timeline of where the time went instead of being
// killed inside a blocking spawnSync.
const buildDeadlineMs = 30_000;
const caseTimeoutMs = buildDeadlineMs + 5_000;

type BuildRun = { status: number | null; timeline: string };

function stampLines(stream: Readable, started: number, lines: string[]): void {
  createInterface({ input: stream }).on('line', (line) => {
    lines.push(`${Math.round(performance.now() - started)} ms  ${line}`);
  });
}

/** Runs build.sh without blocking the test, recording each output line with its elapsed time. */
function runBuildScript(root: string, args: string[], env: NodeJS.ProcessEnv): Promise<BuildRun> {
  return new Promise((done) => {
    const started = performance.now();
    const lines: string[] = [];
    const child = spawn('bash', ['scripts/build.sh', ...args], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    stampLines(child.stdout, started, lines);
    stampLines(child.stderr, started, lines);
    const deadline = setTimeout(() => {
      lines.push(`${buildDeadlineMs} ms  deadline passed, killing build.sh and its children`);
      process.kill(-(child.pid ?? 0), 'SIGKILL');
    }, buildDeadlineMs);
    child.on('close', (status) => {
      clearTimeout(deadline);
      done({ status, timeline: lines.join('\n') });
    });
  });
}

for (const scenario of ['packages-success', 'packages-failure', 'full'] as const) test(`Studio assets after ${scenario}`, async () => {
  const failCompilation = scenario === 'packages-failure';
  const packagesOnly = scenario !== 'full';
  const root = mkdtempSync(join(tmpdir(), 'packages-only-'));
  try {
    mkdirSync(join(root, 'scripts'));
    cpSync(buildScript, join(root, 'scripts/build.sh'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // Compiler processes are the external boundary: exercise the real build
    // orchestration and cleanup without compiling the monorepo in this test.
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\nexit ${failCompilation ? 9 : 0}\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'jq'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nif [ "$1" = run ] && [ "$2" = --cwd ]; then\n mkdir -p "$3/dist"\n echo rebuilt > "$3/dist/rebuilt"\n if [ "$3" = packages/site-docs ]; then echo fresh-site > "$3/dist/index.html"; fi\nfi\n', { mode: 0o755 });
    for (const pkg of ['pyric', 'pyric-admin', 'create-pyric', 'ui', 'cli', 'studio', 'site-docs']) {
      mkdirSync(join(root, 'packages', pkg, 'dist'), { recursive: true });
      writeFileSync(join(root, 'packages', pkg, 'package.json'), '{}');
    }
    const embedded = join(root, 'packages/cli/dist/serve/site-ui');
    mkdirSync(embedded, { recursive: true });
    writeFileSync(join(embedded, 'index.html'), 'built Studio');
    writeFileSync(join(root, 'packages/site-docs/dist/index.html'), 'built site');
    writeFileSync(join(root, 'packages/cli/dist/stale.js'), 'stale package output');
    const run = await runBuildScript(root, packagesOnly ? ['--packages-only'] : [], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    expect(run.status, `build.sh output by elapsed time:\n${run.timeline}`).toBe(failCompilation ? 9 : 0);
    expect(existsSync(join(embedded, 'index.html'))).toBe(true);
    expect(readFileSync(join(embedded, 'index.html'), 'utf8').trim()).toBe(packagesOnly ? 'built Studio' : 'fresh-site');
    expect(readFileSync(join(root, 'packages/site-docs/dist/index.html'), 'utf8').trim()).toBe(packagesOnly ? 'built site' : 'fresh-site');
    expect(existsSync(join(root, 'packages/cli/dist/stale.js'))).toBe(false);
    if (!failCompilation) expect(readFileSync(join(root, 'packages/cli/dist/rebuilt'), 'utf8').trim()).toBe('rebuilt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, caseTimeoutMs);
