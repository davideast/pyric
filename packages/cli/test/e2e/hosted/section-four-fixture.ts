import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export function packedConsumer(): string {
  const selected = process.env.PYRIC_PACKED_CONSUMER;
  const isMissing = selected === undefined;
  if (isMissing) throw new Error('Set PYRIC_PACKED_CONSUMER to the isolated tarball installation.');
  const consumer = realpathSync(selected);
  const repository = realpathSync(new URL('../../../../..', import.meta.url));
  const isWorkspace = consumer.startsWith(repository);
  if (isWorkspace) throw new Error('Packed consumer must be outside the worktree.');
  for (const name of ['@pyric/cli', 'pyric', 'pyric-admin', 'vite']) {
    const installed = realpathSync(join(consumer, 'node_modules', name));
    const escapesConsumer = !installed.startsWith(`${consumer}/node_modules/`);
    if (escapesConsumer) throw new Error(`${name} resolves outside the isolated installation`);
  }
  return consumer;
}

export function packedProject() {
  const consumer = packedConsumer();
  const dir = mkdtempSync(join(consumer, 'checkpoint-'));
  for (const name of ['index.html', 'main.js', 'firestore.rules', 'vite-server.mjs']) {
    copyFileSync(new URL(`../../manual/section-four/${name}`, import.meta.url), join(dir, name));
  }
  return { dir, consumer, close: () => rmSync(dir, { recursive: true, force: true }) };
}

export function startPackedServer(project: ReturnType<typeof packedProject>, mode: 'hosted' | 'sharedworker' | 'vite', port = 0) {
  const isVite = mode === 'vite';
  const flags = ['--no-capture', '--bridge', '--no-open', '--port', String(port), '--json'];
  const isHosted = mode === 'hosted';
  if (isHosted) flags.push('--hosted');
  const cli = join(project.consumer, 'node_modules/@pyric/cli/dist/cli/index.js');
  const args = isVite ? [join(project.dir, 'vite-server.mjs')] : [cli, 'sandbox', ...flags];
  const child = spawn(process.execPath, args, {
    cwd: project.dir, env: { ...process.env, PORT: String(port), CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<void>();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    lines.pop();
    for (const line of lines) {
      const isJson = line.startsWith('{');
      if (isJson) ready.resolve(z.object({ url: z.string().url() }).parse(JSON.parse(line)).url);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', ready.reject);
  child.once('close', code => {
    ready.reject(new Error(`Packed ${mode} exited ${code}: ${stderr}`));
    exited.resolve();
  });
  const deadline = setTimeout(() => ready.reject(new Error(`Packed ${mode} startup timed out: ${stderr}`)), 30_000);
  const url = ready.promise.finally(() => clearTimeout(deadline));
  return {
    url, stderr: () => stderr,
    async stop() {
      const hasExited = child.exitCode !== null || child.signalCode !== null;
      if (hasExited) return;
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await exited.promise; } finally { clearTimeout(kill); }
    },
  };
}
