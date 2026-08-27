#!/usr/bin/env bun
/**
 * Smoke-test the compiled standalone `pyric` binary.
 *
 * Proves the single-file executable runs offline — no node, no node_modules —
 * across the portable command surface AND the embedded-bundle `serve` path
 * (the one that can't use the runtime esbuild bundler). Run after a compile:
 *   bun run build && bun scripts/compile.ts host && bun scripts/standalone-smoke.ts
 *
 * Exits non-zero on the first failure. CI runs this as the standalone gate.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'dist-bin', 'pyric');

if (!existsSync(BIN)) {
  process.stderr.write(`smoke: no binary at ${BIN}. Run "bun scripts/compile.ts host" first.\n`);
  process.exit(1);
}

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed++;
}

const run = (args: string[]): { code: number; out: string; err: string } => {
  const r = spawnSync(BIN, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

// ── Portable commands ─────────────────────────────────────────────────
process.stdout.write('standalone smoke:\n');
const ver = run(['--version']);
check('--version', ver.code === 0 && /\d+\.\d+\.\d+/.test(ver.out.trim()), ver.out.trim());

const help = run(['--help']);
check('--help', help.code === 0 && help.out.includes('USAGE'));

const work = mkdtempSync(join(tmpdir(), 'pyric-smoke-'));
const rulesPath = join(work, 'firestore.rules');
writeFileSync(
  rulesPath,
  'rules_version = "2";\nservice cloud.firestore {\n  match /databases/{db}/documents {\n' +
    '    match /{doc=**} { allow read, write: if false; }\n  }\n}\n',
);
const lint = run(['firestore', 'rules', 'lint', rulesPath]);
check('firestore rules lint', lint.code === 0 && lint.out.includes('"metrics"'));
const validate = run(['firestore', 'rules', 'validate', rulesPath]);
check('firestore rules validate', validate.code === 0);

// ── Embedded serve (the headline path) ────────────────────────────────
writeFileSync(join(work, 'index.html'), '<!doctype html><html><body>smoke</body></html>');
const PORT = 5310;
const child = spawn(BIN, ['sandbox', '--port', String(PORT), '--no-open', '--no-watch', '--ui', '--json'], {
  cwd: work,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serveErr = '';
child.stderr.on('data', (d) => (serveErr += d));

const base = `http://127.0.0.1:${PORT}`;
const get = async (p: string): Promise<number> => {
  try {
    return (await fetch(base + p)).status;
  } catch {
    return 0;
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let ready = false;
for (let i = 0; i < 40; i++) {
  if ((await get('/__pyric/init.json')) === 200) {
    ready = true;
    break;
  }
  await sleep(250);
}
check('serve boots (init.json 200)', ready, ready ? '' : serveErr.split('\n').slice(-3).join(' ').trim());

if (ready) {
  for (const p of [
    '/__pyric/sdk/app.js',
    '/__pyric/sdk/auth.js',
    '/__pyric/sdk/firestore.js',
    '/__pyric/sdk/init.js',
    '/__pyric/sdk/worker.js',
  ]) {
    check(`serve embeds ${p}`, (await get(p)) === 200);
  }
  // The shim must be the pyric sandbox, not a stray real-firebase passthrough.
  const appBody = await fetch(base + '/__pyric/sdk/app.js').then((r) => r.text());
  check('app.js is the sandbox shim', appBody.includes('pyric sandbox shim'));
  check('dev --ui serves Studio', (await get('/__pyric/ui/index.html')) === 200);
}

child.kill('SIGTERM');
await sleep(250);
if (!child.killed) child.kill('SIGKILL');

process.stdout.write(failed === 0 ? '\n✅ standalone smoke passed\n' : `\n❌ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
