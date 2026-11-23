import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { standInNodeCommand } from '../../../../test/apps/ai-stream-abort/stand-in-runtime.ts';
import { resolveNodeExecutable } from './require-node-on-path.js';

const SCENARIO_PATH = fileURLToPath(
  new URL('../../../../test/apps/ai-stream-abort/scenario.ts', import.meta.url),
);
const STAND_IN_PATH = fileURLToPath(
  new URL('../../../../test/apps/ai-stream-abort/stand-in.mjs', import.meta.url),
);

interface StandInRecord {
  kind: 'stream' | 'slow-headers';
  chunksWritten: number;
  headersSent: boolean;
  disconnected: boolean;
  done: boolean;
}

describe('ai-stream-abort stand-in Node runtime guard (#3284)', () => {
  it('selects node from process.versions.bun regardless of the Bun binary filename', () => {
    expect(
      standInNodeCommand({ bun: '1.3.11' }, '/usr/local/bin/bun'),
    ).toBe('node');
    expect(
      standInNodeCommand({ bun: '1.3.11' }, '/opt/runner/node_modules/bun/bin/bun.exe'),
    ).toBe('node');
    expect(
      standInNodeCommand({ bun: '1.3.11' }, 'C:\\Users\\runner\\.bun\\bin\\bun.exe'),
    ).toBe('node');
    expect(
      standInNodeCommand({ bun: '1.3.14' }, '/usr/local/bin/bun-1.3.14'),
    ).toBe('node');
  });

  it('reuses execPath when process.versions.bun is absent', () => {
    expect(
      standInNodeCommand({}, '/usr/local/bin/node'),
    ).toBe('/usr/local/bin/node');
    expect(
      standInNodeCommand({ bun: '' }, 'C:\\Program Files\\nodejs\\node.exe'),
    ).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('wires scenario.ts to standInNodeCommand instead of execPath suffix matching', () => {
    const source = readFileSync(SCENARIO_PATH, 'utf8');
    expect(source).toContain('standInNodeCommand()');
    expect(source).not.toContain("endsWith('bun')");
  });

  it('fails fast with exit code 1 if stand-in.mjs is launched under Bun', async () => {
    const child = spawn(process.execPath, [STAND_IN_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('STAND_IN_READY')) {
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 5_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(stdout).not.toContain('STAND_IN_READY');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('stand-in.mjs requires Node.js');
  });

  it('records mid-stream TCP disconnect promptly when stand-in.mjs runs on Node.js', async () => {
    const nodeBin = resolveNodeExecutable();
    const child = spawn(nodeBin, [STAND_IN_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    try {
      const baseUrl = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`stand-in failed to listen: ${stderr || stdout}`));
        }, 10_000);
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          const match = stdout.match(/^STAND_IN_READY (http:\/\/127\.0\.0\.1:\d+)$/m);
          if (match?.[1] !== undefined) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`stand-in exited early (${String(code)}): ${stderr || stdout}`));
        });
      });

      const port = Number(new URL(baseUrl).port);
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
          socket.write(
            [
              'POST /v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse HTTP/1.1',
              `Host: 127.0.0.1:${port}`,
              'Content-Type: application/json',
              'Content-Length: 15',
              '',
              '{"contents":[]}',
            ].join('\r\n'),
          );
        });
        let received = '';
        socket.on('data', (chunk: Buffer) => {
          received += chunk.toString('utf8');
          const seenChunks = (received.match(/data: /g) ?? []).length;
          if (seenChunks >= 3) {
            socket.destroy();
            resolve();
          }
        });
        socket.on('error', reject);
      });

      const deadline = Date.now() + 5_000;
      let record: StandInRecord | undefined;
      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/_records`);
        const records = (await response.json()) as StandInRecord[];
        if (records[0]?.disconnected === true) {
          record = records[0];
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(record).toBeDefined();
      expect(record?.disconnected).toBe(true);
      expect(record?.done).toBe(false);
      expect((record?.chunksWritten ?? 40) < 15).toBe(true);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 2_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }, 15_000);
});
