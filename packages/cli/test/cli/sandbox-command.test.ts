import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

function runCli(
  args: string[],
  cwd?: string,
): { code: number; stdout: string; stderr: string } {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'pyric-cli-test-'));
  try {
    const result = spawnSync('bun', [CLI_ENTRY, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    if (!cwd) rmSync(dir, { recursive: true, force: true });
  }
}

describe('pyric sandbox command execution', () => {
  it('executes a short-lived node script and cleanly exits with code 0', () => {
    const { code, stdout, stderr } = runCli([
      'sandbox',
      '--no-open',
      'node',
      '-e',
      'console.log("SANDBOX_CHILD_HELLO")',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('SANDBOX_CHILD_HELLO');
  });

  it('propagates the child script non-zero exit code to the parent CLI process', () => {
    const { code } = runCli([
      'sandbox',
      '--no-open',
      'node',
      '-e',
      'process.exit(42)',
    ]);
    expect(code).toBe(42);
  });

  it('runs the command configured in pyric.json when no CLI command is provided', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-sandbox-cmd-'));
    try {
      writeFileSync(
        join(tmp, 'pyric.json'),
        JSON.stringify({
          command: 'node -e "console.log(\'CONFIG_COMMAND_FIRED\')"',
        }),
      );
      const { code, stdout } = runCli(['sandbox', '--no-open'], tmp);
      expect(code).toBe(0);
      expect(stdout).toContain('CONFIG_COMMAND_FIRED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('explicit CLI command takes precedence over pyric.json command', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-sandbox-precedence-'));
    try {
      writeFileSync(
        join(tmp, 'pyric.json'),
        JSON.stringify({
          command: 'node -e "console.log(\'FROM_CONFIG\')"',
        }),
      );
      const { code, stdout } = runCli(
        ['sandbox', '--no-open', 'node', '-e', 'console.log("FROM_CLI")'],
        tmp,
      );
      expect(code).toBe(0);
      expect(stdout).toContain('FROM_CLI');
      expect(stdout).not.toContain('FROM_CONFIG');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects port from pyric.json and injects matching PYRIC_SANDBOX into child', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-sandbox-port-'));
    try {
      writeFileSync(
        join(tmp, 'pyric.json'),
        JSON.stringify({
          port: 4892,
          command: 'node -e "console.log(\'URL:\' + process.env.PYRIC_SANDBOX)"',
        }),
      );
      const { code, stdout } = runCli(['sandbox', '--no-open'], tmp);
      expect(code).toBe(0);
      expect(stdout).toContain('URL:remote:http://localhost:4892');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports root import from firebase-admin under pyric sandbox', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pyric-sandbox-admin-root-'));
    try {
      writeFileSync(
        join(tmp, 'script.mjs'),
        `import admin from 'firebase-admin';
         console.log('ADMIN_INITIALIZE_FN:', typeof admin.initializeApp);
         console.log('ADMIN_FIRESTORE_FN:', typeof admin.firestore);`,
      );
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
      const { code, stdout } = runCli(['sandbox', '--no-open', 'node', 'script.mjs'], tmp);
      expect(code).toBe(0);
      expect(stdout).toContain('ADMIN_INITIALIZE_FN: function');
      expect(stdout).toContain('ADMIN_FIRESTORE_FN: function');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts short flag -p 4912 to customize port without breaking child command', () => {
    const { code, stdout } = runCli([
      'sandbox',
      '-p',
      '4912',
      '--no-open',
      'node',
      '-e',
      'console.log("PORT_URL:" + process.env.PYRIC_SANDBOX)',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('PORT_URL:remote:http://localhost:4912');
  });

  it('extracts inline environment variables from child command', () => {
    const { code, stdout } = runCli([
      'sandbox',
      '--no-open',
      'CUSTOM_ENV=alpha123',
      'node',
      '-e',
      'console.log("READ_ENV:" + process.env.CUSTOM_ENV)',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('READ_ENV:alpha123');
  });

  it('executes inline code containing logical operators (||) without breaking arguments', () => {
    const { code, stdout } = runCli([
      'sandbox',
      '--no-open',
      'node',
      '-e',
      'console.log("OPERATOR_TEST:" + (false || "fallback_value"))',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('OPERATOR_TEST:fallback_value');
  });

  it('runs in host-only mode when no command or config is provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-cli-host-'));
    try {
      const child = spawn('bun', [CLI_ENTRY, 'sandbox', '--no-open', '--no-run', '--port', '4933'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.setEncoding('utf8');
      let stdout = '';
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });

      const start = Date.now();
      while (!stdout.includes('export PYRIC_SANDBOX="remote:http://localhost:4933"') && Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(stdout).toContain('export PYRIC_SANDBOX="remote:http://localhost:4933"');
      child.kill('SIGINT');
      const code = await new Promise<number>((resolve) => {
        child.once('exit', (exit) => resolve(exit ?? 0));
      });
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

/**
 * The launcher makes no claim about the child's build output. `withPyric`
 * externalizes firebase and firebase-admin, the backend-bundler docs say to
 * mark them external, and the net guard reports real egress at runtime with
 * attribution. Grepping .next/server or dist at launch only warned about
 * production or stale artifacts the child never loads.
 */
describe('pyric sandbox does not scan build output', () => {
  it('says nothing about an inlined-SDK artifact under .next/server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-artifacts-'));
    try {
      mkdirSync(join(dir, '.next', 'server'), { recursive: true });
      writeFileSync(
        join(dir, '.next', 'server', 'chunk.js'),
        'fetch("https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents")',
      );
      const { code, stdout, stderr } = runCli(
        ['sandbox', '--no-open', '--port', '4941', 'node', '-e', 'console.log("ARTIFACT_CHILD")'],
        dir,
      );
      const all = stdout + stderr;
      expect(all).not.toContain('.next/server/chunk.js');
      expect(all).not.toContain('preflight');
      expect(stdout).toContain('ARTIFACT_CHILD');
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('pyric sandbox unsupported-runtime warning', () => {
  it('warns that interception is unsupported under bun and still launches', () => {
    const { code, stdout, stderr } = runCli([
      'sandbox',
      '--no-open',
      '--port',
      '4944',
      'bun',
      '-e',
      'console.log("BUN_CHILD")',
    ]);
    const all = stdout + stderr;
    expect(all).toContain('⚠ runtime');
    expect(all).toContain('bun');
    expect(all).toContain('not supported');
    expect(all).toContain('LIVE Firebase');
    // The net-guard backstop is Node-only, and the warning has to say so.
    expect(all).toContain('net-guard');
    expect(stdout).toContain('BUN_CHILD');
    expect(code).toBe(0);
  }, 60_000);

  it('stays silent for a node child', () => {
    const { code, stdout, stderr } = runCli([
      'sandbox',
      '--no-open',
      '--port',
      '4945',
      'node',
      '-e',
      'console.log("NODE_CHILD")',
    ]);
    expect(stdout + stderr).not.toContain('⚠ runtime');
    expect(stdout).toContain('NODE_CHILD');
    expect(code).toBe(0);
  }, 60_000);
});
