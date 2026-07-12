import { describe, expect, it, mock } from 'bun:test';

import { runFirestoreIndexesGenerate, runFirestoreRulesResolve } from '../../src/cli/rules.js';
import { parseArgs } from '../../src/cli/parse-args.js';

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(value: string) { stdout += value; } },
    stderr: { write(value: string) { stderr += value; } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

describe('local Firestore artifact generation', () => {
  it('resolves a modules rules file to stdout', async () => {
    const output = io();
    const code = await runFirestoreRulesResolve(
      parseArgs(['resolve', 'firestore.modules.rules']),
      {
        ...output,
        cwd: '/workspace',
        readFile: mock(async () => "rules_version = '2+modules';"),
        resolveModules: mock(() => ({
          success: true as const,
          data: { resolved: "rules_version = '2';\n", modules: [] },
        })),
      },
    );

    expect(code).toBe(0);
    expect(output.stdoutText).toBe("rules_version = '2';\n");
  });

  it('writes generated composite indexes to --out', async () => {
    const output = io();
    const writeFile = mock(async () => undefined);
    const code = await runFirestoreIndexesGenerate(
      parseArgs(['generate', 'src/app.ts', '--out', 'firestore.indexes.json']),
      {
        ...output,
        cwd: '/workspace',
        mkdir: mock(async () => undefined),
        writeFile,
        extractIndexes: mock(() => ({
          success: true as const,
          data: {
            config: { indexes: [], fieldOverrides: [] },
            shapesEnumerated: 0,
            warnings: [],
            signals: [],
            annotationsApplied: [],
          },
        })),
      },
    );

    expect(code).toBe(0);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]?.[0]).toBe('/workspace/firestore.indexes.json');
    expect(writeFile.mock.calls[0]?.[1]).toContain('"indexes": []');
  });
});
