import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  formatBridgeTipLine,
  formatBrowserPersistNoticeLine,
  PERSISTENCE_GUIDE_URL,
} from '../../src/cli/child-app-origin.js';
import { startServe } from '../../src/cli/serve.js';
import { resolveNodeExecutable } from '../serve/require-node-on-path.js';

const CLI_DIST_ENTRY = resolve(import.meta.dir, '../../dist/cli/index.js');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-banner-nits-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><body>ok</body></html>');
  return dir;
}

describe('pyric sandbox startup banner polish (#1189)', () => {
  it('points SharedWorker state notice at published docs instead of nonexistent repo path', async () => {
    expect(formatBrowserPersistNoticeLine()).toContain(PERSISTENCE_GUIDE_URL);
    expect(formatBrowserPersistNoticeLine()).not.toContain(
      'docs/how-to/serve-persistence-and-multi-tab.md',
    );

    const cwd = makeTempProject();
    const notes: string[] = [];
    const runtime = await startServe({
      cwd,
      port: 0,
      cacheRoot: join(cwd, '.cache'),
      logger: {
        info: (msg) => notes.push(msg),
        note: (msg) => notes.push(msg),
        warn: (msg) => notes.push(msg),
      },
    });
    try {
      const joined = notes.join('\n');
      expect(joined).toContain(PERSISTENCE_GUIDE_URL);
      expect(joined).not.toContain('docs/how-to/serve-persistence-and-multi-tab.md');
    } finally {
      await runtime.handle.stop();
    }
  }, 30_000);

  it('formats bridge tip with runnable command prefix', () => {
    const tip = formatBridgeTipLine({
      moduleFilePath: '/app/node_modules/@pyric/cli/dist/cli/index.js',
      pathEnv: '',
      embedded: false,
    });
    expect(tip).toContain('re-run with --bridge');
    expect(tip).toContain('`npx pyric mcp-proxy`');
  });

  it('prints MCP endpoint without telling the user to re-run with --bridge under --hosted', async () => {
    const nodeBin = resolveNodeExecutable();
    if (!existsSync(CLI_DIST_ENTRY)) {
      throw new Error(`Build packages/cli before running hosted banner test: ${CLI_DIST_ENTRY}`);
    }
    const cwd = makeTempProject();
    const child = spawn(
      nodeBin,
      [CLI_DIST_ENTRY, 'sandbox', '--hosted', '--port', '0', '--host', '127.0.0.1', '--no-open'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });

    try {
      const deadline = Date.now() + 20_000;
      while (!output.includes('PYRIC_SANDBOX=remote') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 150));
      expect(output).toContain('PYRIC_SANDBOX=remote');
      expect(output).toContain('MCP endpoint:');
      expect(output).not.toContain('re-run with --bridge');
      expect(output).not.toContain('docs/how-to/serve-persistence-and-multi-tab.md');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolveExit();
        }, 5_000);
        child.once('close', () => {
          clearTimeout(killTimer);
          resolveExit();
        });
      });
    }
  }, 30_000);
});
