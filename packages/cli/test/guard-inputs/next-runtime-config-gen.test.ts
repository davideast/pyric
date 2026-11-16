/**
 * Generative verification of Next.js segment config export combinations
 * (`runtime` x `config.runtime`) across App routes, Pages API routes,
 * `middleware.ts`, and `proxy.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { enforceNoEdgeRuntime, findEdgeRuntimeFiles } from '../../src/next/edge-runtime.js';
import {
  SEGMENT_RUNTIME_MODULE_PATH,
  SEGMENT_RUNTIME_MODULE_SOURCE,
  generateBatchRouteConfigMatrix,
  generateSingleRootConfigMatrix,
} from './next-runtime-config-gen.js';

const tempDirs: string[] = [];

function createNextProjectFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@/*': ['./*'] },
      },
    }),
  );
  const configFull = join(root, SEGMENT_RUNTIME_MODULE_PATH);
  mkdirSync(dirname(configFull), { recursive: true });
  writeFileSync(configFull, SEGMENT_RUNTIME_MODULE_SOURCE);
  return root;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Next.js segment config cartesian generator (runtime x config.runtime)', () => {
  it('6a. classifies every App route and Pages API runtime x config combination against the fail-closed specification', () => {
    const root = createNextProjectFixture('pyric-gen-next-routes-');
    const cases = generateBatchRouteConfigMatrix();
    expect(cases.length).toBeGreaterThanOrEqual(198);

    for (const entry of cases) {
      writeProjectFile(root, entry.relativePath, entry.source);
    }

    const detected = new Set(findEdgeRuntimeFiles(root));
    const mismatches: string[] = [];
    for (const entry of cases) {
      const actualFlagged = detected.has(entry.relativePath);
      if (actualFlagged !== entry.expectedFlagged) {
        mismatches.push(
          `${entry.id}: expected flagged=${String(entry.expectedFlagged)}, got ${String(actualFlagged)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);

    let thrownCode: string | undefined;
    try {
      enforceNoEdgeRuntime(root, {});
    } catch (error) {
      thrownCode = (error as { code?: string }).code;
    }
    expect(thrownCode).toBe('PYRIC_EDGE_RUNTIME_UNSUPPORTED');
  });

  it('6b. classifies every middleware.ts and proxy.ts runtime x config combination against the specification', () => {
    const root = createNextProjectFixture('pyric-gen-next-single-');
    const mismatches: string[] = [];

    for (const targetKind of ['middleware', 'proxy'] as const) {
      const cases = generateSingleRootConfigMatrix(targetKind);
      expect(cases.length).toBeGreaterThanOrEqual(99);

      for (const entry of cases) {
        const targetPath = join(root, entry.relativePath);
        writeFileSync(targetPath, entry.source);
        const detected = new Set(findEdgeRuntimeFiles(root));
        const actualFlagged = detected.has(entry.relativePath);
        if (actualFlagged !== entry.expectedFlagged) {
          mismatches.push(
            `${entry.id}: expected flagged=${String(entry.expectedFlagged)}, got ${String(actualFlagged)}`,
          );
        }
        rmSync(targetPath, { force: true });
      }
    }

    expect(mismatches).toEqual([]);
  });
});
