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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as cli from '../../src/cli/index.js';
import { EMBEDDED_WORKSPACE_PACKAGES, generatedEntrySource } from '../../scripts/standalone-embed.js';

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
    // Bun compiled binaries expose [binary, ...userArgs], unlike Node's
    // [runtime, script, ...userArgs]. Forward the compiled shape explicitly
    // so runDirect does not discard the first command or flag.
    expect(src).toContain('.runDirect(process.argv.slice(1))');
    // The embedded-assets global must be installed before the CLI import so
    // `isStandalone()` is true during module evaluation.
    expect(src.indexOf('__PYRIC_EMBEDDED__')).toBeLessThan(src.indexOf('await import'));
  });
});

describe('embedded tarball coverage (issue #369, defect 2)', () => {
  it('embeds a tarball for @pyric/cli and EVERY workspace:* dep in its manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../../package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const embedded = new Set(EMBEDDED_WORKSPACE_PACKAGES.map((p) => p.name));
    expect(embedded.has('@pyric/cli')).toBe(true);
    // Runtime deps only: devDependencies never ship in the packed manifest.
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!spec.startsWith('workspace:')) continue;
        expect(embedded.has(name)).toBe(true);
      }
    }
  });

  it('gives every embedded package a stable, unique tarball filename', () => {
    const files = EMBEDDED_WORKSPACE_PACKAGES.map((p) => p.tarball);
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) expect(f).toMatch(/^[a-z-]+\.tgz$/);
  });
});
