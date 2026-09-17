import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./lib/packaging-processes.sh', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'process lifecycle condition timed out');
    await delay(20);
  }
}

for (const [mode, expected] of [['success', 0], ['error', 1], ['exit', 7], ['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['stubborn', 7]]) {
  test(`packaging cleans its process group on ${mode}`, { timeout: 10000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-packaging-lifecycle-'));
    const pidFile = join(root, 'pids');
    const pids = () => existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : [];
    const ignoreTerm = mode === 'stubborn' ? "process.on('SIGTERM', () => {});" : '';
    writeFileSync(join(root, 'child.mjs'), `
      import { appendFileSync } from 'node:fs';
      ${ignoreTerm}
      appendFileSync(process.argv[2], process.pid + '\\n');
      setInterval(() => {}, 1000);
    `);
    writeFileSync(join(root, 'launcher.mjs'), `
      import { appendFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      ${ignoreTerm}
      appendFileSync(process.argv[2], process.pid + '\\n');
      spawn(process.execPath, [process.argv[3], process.argv[2]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `);
    const finish = mode === 'success' ? 'stop_packaging_server; stop_packaging_server; exit 0' : mode === 'error' ? 'false' : 'exit 7';
    const shell = spawn('bash', ['-c', `
      set -euo pipefail
      WORK="$2"
      source "$1"
      start_packaging_server "$2" "$3" "$2/launcher.mjs" "$2/pids" "$2/child.mjs"
      while [ ! -f "$2/release" ]; do sleep 0.02; done
      ${finish}
    `, 'packaging-test', helper, root, process.execPath], { stdio: 'ignore' });
    const exited = once(shell, 'exit');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const unrelatedExit = once(unrelated, 'exit');
    try {
      await until(() => pids().length === 2);
      const started = Date.now();
      if (mode.startsWith('SIG')) shell.kill(mode);
      else writeFileSync(join(root, 'release'), 'finish');
      assert.equal((await exited)[0], expected);
      await until(() => pids().every(pid => !alive(pid)));
      assert.ok(Date.now() - started < 5000, 'cleanup must be bounded');
      assert.equal(alive(unrelated.pid), true, 'unrelated process must survive');
      assert.equal(existsSync(root), true, 'cleanup must preserve failure evidence');
    } finally {
      for (const pid of pids().reverse()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      shell.kill('SIGKILL');
      unrelated.kill('SIGKILL');
      await unrelatedExit;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('packaging preserves a server startup failure status', { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pyric-packaging-startup-'));
  const shell = spawn('bash', ['-c', 'set -euo pipefail; WORK="$2"; source "$1"; start_packaging_server "$2" "$3" -e "process.exit(23)"; wait "$SERVE_PID"', 'test', helper, root, process.execPath], { stdio: 'ignore' });
  try { assert.equal((await once(shell, 'exit'))[0], 23); }
  finally { shell.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
