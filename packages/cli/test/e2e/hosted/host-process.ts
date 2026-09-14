import { spawn } from 'node:child_process';
import { CLI_PATH } from '../soak/harness.js';

type Startup = { kind: 'ready' } | { kind: 'exit'; code: number | null };

/** Start another real host in an existing project; observe its public readiness or exit. */
export function startHost(
  projectDir: string,
  port = 0,
  command: readonly [string, ...string[]] = [process.execPath, CLI_PATH],
  flags: readonly string[] = ['--hosted'],
) {
  const [executable, ...prefix] = command;
  const child = spawn(executable, [
    ...prefix, 'sandbox', ...flags, '--bridge', '--no-open', '--port', String(port),
    '--json', '--no-cache', '--no-capture',
  ], { cwd: projectDir, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const startup = Promise.withResolvers<Startup>();
  const exited = Promise.withResolvers<void>();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    lines.pop();
    const publishedReady = lines.some((line) => line.startsWith('{'));
    if (publishedReady) startup.resolve({ kind: 'ready' });
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', startup.reject);
  child.once('close', (code) => {
    startup.resolve({ kind: 'exit', code });
    exited.resolve();
  });
  return {
    child,
    startup: startup.promise,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop(): Promise<void> {
      const hasExited = child.exitCode !== null || child.signalCode !== null;
      if (hasExited) return;
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        await exited.promise;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
