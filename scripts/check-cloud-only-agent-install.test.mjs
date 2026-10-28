import { describe, expect, test } from 'bun:test';
import { inspectCloudOnlyDependencyTree } from './lib/check-cloud-only-agent-install.mjs';

describe('cloud-only agent dependency inspection', () => {
  test('accepts an npm tree where both optional runtimes are absent', () => {
    expect(inspectCloudOnlyDependencyTree({ name: 'consumer', version: '0.0.0' }, 0)).toEqual([]);
  });

  test('rejects a fatal npm exit even when its JSON looks clean', () => {
    expect(() =>
      inspectCloudOnlyDependencyTree({ name: 'consumer', version: '0.0.0' }, 1),
    ).toThrow('npm dependency inspection exited with unexpected status 1');
  });

  test('rejects npm error payloads instead of treating them as an empty tree', () => {
    expect(() =>
      inspectCloudOnlyDependencyTree(
        { error: { code: 'EOVERRIDE', summary: 'Override conflict' } },
        0,
      ),
    ).toThrow('npm dependency inspection failed (EOVERRIDE): Override conflict');
  });

  test('rejects dependency problems disclosed below the root', () => {
    expect(() =>
      inspectCloudOnlyDependencyTree(
        {
          dependencies: {
            indirect: { problems: ['invalid: child@1.0.0'] },
          },
        },
        0,
      ),
    ).toThrow('npm dependency inspection reported problems: invalid: child@1.0.0');
  });

  test('ignores npm optional-peer placeholders that have no installed version', () => {
    expect(
      inspectCloudOnlyDependencyTree(
        {
          dependencies: {
            '@inbrowser/model': {
              dependencies: { '@huggingface/transformers': {} },
            },
          },
        },
        0,
      ),
    ).toEqual([]);
  });

  test('finds forbidden runtimes anywhere in the dependency tree', () => {
    const tree = {
      dependencies: {
        '@inbrowser/agent': {
          dependencies: {
            '@inbrowser/model': {
              dependencies: {
                '@huggingface/transformers': { version: '3.8.0' },
                indirect: { dependencies: { 'onnxruntime-node': { version: '1.21.0' } } },
              },
            },
          },
        },
      },
    };

    expect(inspectCloudOnlyDependencyTree(tree, 0)).toEqual([
      '@huggingface/transformers',
      'onnxruntime-node',
    ]);
  });

  test('rejects malformed JSON roots', () => {
    expect(() => inspectCloudOnlyDependencyTree(null, 0)).toThrow(
      'npm dependency inspection returned a malformed tree',
    );
  });
  test("isMain detects symlinked execution", async () => {
    const { mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    
    const tmp = join(import.meta.dir, "tmp-symlink-test");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    
    const scriptPath = join(import.meta.dir, "lib/check-cloud-only-agent-install.mjs");
    const linkPath = join(tmp, "check.mjs");
    symlinkSync(scriptPath, linkPath);
    
    const { status, stdout, stderr } = spawnSync("bun", [linkPath, "0"], {
      input: JSON.stringify({ name: "consumer", version: "0.0.0" }),
      encoding: "utf8"
    });
    
    rmSync(tmp, { recursive: true, force: true });
    
    console.log(stderr); expect(stdout).toContain("neither @huggingface/transformers nor onnxruntime-node is installed");
    expect(status).toBe(0);
  });
});
