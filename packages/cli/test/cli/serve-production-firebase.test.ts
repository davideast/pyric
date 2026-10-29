import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe } from '../../src/cli/serve.js';

const testTimeoutMs = 30_000;

function projectWithoutFirebase(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-serve-prod-no-firebase-'));
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: '.' } }));
  return cwd;
}

async function withProductionMode<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.PYRIC_AI_MODE;
  process.env.PYRIC_AI_MODE = 'production';
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PYRIC_AI_MODE;
    else process.env.PYRIC_AI_MODE = saved;
  }
}

describe('startServe in production AI mode without a resolvable firebase', () => {
  it('stops at startup for plain pyric sandbox', async () => {
    const cwd = projectWithoutFirebase();
    const quiet = { note() {}, info() {}, warn() {} };
    await withProductionMode(async () => {
      await expect(startServe({ cwd, port: 0, watch: false, logger: quiet })).rejects.toThrow(/npm install firebase/);
    });
  }, testTimeoutMs);

  it('starts with a child command, warns once, and answers the SDK URL with a clear 404', async () => {
    const cwd = projectWithoutFirebase();
    const lines: string[] = [];
    const record = (msg: string) => {
      lines.push(msg);
    };
    await withProductionMode(async () => {
      const runtime = await startServe({
        cwd,
        port: 0,
        watch: false,
        hasChildCommand: true,
        logger: { note: record, info: record, warn: record },
      });
      try {
        const sdk = await fetch(new URL('/__pyric/sdk/firebase-sdk-app.js', runtime.handle.url));
        expect(sdk.status).toBe(404);
        expect(await sdk.text()).toContain('Firebase SDK was not built');
      } finally {
        await runtime.handle.stop();
      }
    });
    expect(lines.filter((line) => line.includes('no firebase package resolves'))).toHaveLength(1);
  }, testTimeoutMs);
});
