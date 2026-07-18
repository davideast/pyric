/**
 * Pins the standalone binary's entry contract (issue #369, defect 1).
 *
 * The compiled binary's generated entry imports the CLI module — where
 * `import.meta.main` is false and `process.argv[1]` is the user's first
 * argument, so `isDirectRun()` can never fire. The entry must therefore call
 * an explicit exported run function. These tests pin both sides of that
 * handshake so neither can regress into a silent exit-0 binary.
 */
import { describe, expect, it } from 'bun:test';

import * as cli from '../../src/cli/index.js';
import { generatedEntrySource } from '../../scripts/standalone-embed.js';

describe('standalone entry contract', () => {
  it('the CLI module exports an explicit runDirect entry', () => {
    expect(typeof cli.runDirect).toBe('function');
  });

  it('the generated entry invokes runDirect instead of relying on direct-run detection', () => {
    const src = generatedEntrySource({
      version: '1.2.3',
      assetVersion: 'aaaa',
      workerVersion: 'bbbb',
      cliImportSpecifier: '../dist/cli/index.js',
    });
    expect(src).toContain(`await import("../dist/cli/index.js")`);
    expect(src).toContain('.runDirect()');
    // The embedded-assets global must be installed before the CLI import so
    // `isStandalone()` is true during module evaluation.
    expect(src.indexOf('__PYRIC_EMBEDDED__')).toBeLessThan(src.indexOf('await import'));
  });
});
