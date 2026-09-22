import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const cliDir = resolve(here, '../../..');
export const repoRoot = resolve(cliDir, '../..');
export const cliPath = join(cliDir, 'dist/cli/index.js');

export interface HostedProject {
  dir: string;
  cleanup: () => void;
}

export function createHostedProject(extraFiles: Record<string, string> = {}): HostedProject {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-hosted-smoke-')));
  const nm = join(dir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });

  symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'));
  symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'));
  symlinkSync(cliDir, join(nm, '@pyric', 'cli'));

  const rootNm = join(repoRoot, 'node_modules');
  if (existsSync(join(rootNm, 'firebase-admin'))) {
    symlinkSync(join(rootNm, 'firebase-admin'), join(nm, 'firebase-admin'));
  }
  if (existsSync(join(rootNm, 'firebase'))) {
    symlinkSync(join(rootNm, 'firebase'), join(nm, 'firebase'));
  }

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'hosted-smoke-project', type: 'module' }),
  );
  writeFileSync(
    join(dir, 'firestore.rules'),
    `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`,
  );
  writeFileSync(
    join(dir, 'storage.rules'),
    `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if request.auth != null; }
  }
}`,
  );

  for (const [name, content] of Object.entries(extraFiles)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

export interface HostedStartupReady {
  kind: 'ready';
  url: string;
  port: number;
  uiUrl: string | null;
  mcpUrl: string | null;
}

export interface HostedStartupExit {
  kind: 'exit';
  code: number | null;
  stderr: string;
  stdout: string;
}

export type HostedStartup = HostedStartupReady | HostedStartupExit;

export interface HostedProcess {
  child: ChildProcess;
  startup: Promise<HostedStartup>;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<void>;
}

export function startHost(
  projectDir: string,
  options: {
    flags?: string[];
    passthrough?: string[];
    port?: number;
  } = {},
): HostedProcess {
  const port = options.port ?? 0;
  const flags = options.flags ?? ['--hosted'];
  const args = [
    cliPath,
    'sandbox',
    ...flags,
    '--bridge',
    '--ui',
    '--no-open',
    '--port',
    String(port),
    '--json',
    '--no-cache',
    '--no-capture',
    ...(options.passthrough && options.passthrough.length > 0 ? ['--', ...options.passthrough] : []),
  ];

  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startup = Promise.withResolvers<HostedStartup>();
  const exited = Promise.withResolvers<void>();
  let stdout = '';
  let stderr = '';

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as { url?: string; port?: number; uiUrl?: string; mcpUrl?: string };
          if (parsed.url && parsed.port) {
            startup.resolve({
              kind: 'ready',
              url: parsed.url,
              port: parsed.port,
              uiUrl: parsed.uiUrl ?? null,
              mcpUrl: parsed.mcpUrl ?? null,
            });
            return;
          }
        } catch {
          // Incomplete JSON line, ignore
        }
      }
    }
  });

  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.once('error', (err) => startup.reject(err));
  child.once('close', (code) => {
    startup.resolve({ kind: 'exit', code, stderr, stdout });
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
