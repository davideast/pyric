import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { acquireDiskAdapter } from '../../../src/assurance-surface/code/node-walk.js';
import { posixDirname } from '../../../src/assurance-surface/code/posix-path.js';

describe('node-walk', () => {
  test('walks a real directory on disk via lazy process.getBuiltinModule', () => {
    const adapter = acquireDiskAdapter();
    const thisDir = posixDirname(fileURLToPath(import.meta.url));
    const resolved = adapter.resolve(thisDir);
    expect(adapter.directoryExists(resolved)).toBe(true);
    expect(adapter.fileExists(`${resolved}/harness.ts`)).toBe(true);
    expect(adapter.readFile(`${resolved}/harness.ts`)).toContain('harness');

    const walked = adapter.walk(resolved, 400_000);
    expect(walked.sources.some((p) => p.endsWith('/harness.ts'))).toBe(true);
  });

  test('throws a clear browser-mode error when globalThis.process is absent', () => {
    const holder = globalThis as Record<string, unknown>;
    const saved = holder.process;
    delete holder.process;
    try {
      expect(() => acquireDiskAdapter()).toThrow(/files/i);
    } finally {
      holder.process = saved;
    }
  });
});
