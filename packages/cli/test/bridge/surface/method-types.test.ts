/**
 * The record type keeps a sandbox-side handler off the bridge's context.
 *
 * A record filed beside the real ones is compiled with the package's own
 * tsconfig. A sandbox-side handler that annotates `ctx` as the wider
 * `SurfaceContext` to read `projectDir` must not compile; the same handler on
 * a bridge-side record must. Declaring `handler` with method syntax would make
 * its parameter bivariant and let the first one through.
 */
import { beforeAll, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SURFACE_DIRECTORY = join(PACKAGE_ROOT, 'src', 'bridge', 'surface');
const PROBE_PATH = join(SURFACE_DIRECTORY, 'methods', 'firestore', '__runs-in-probe.ts');

/** A record whose handler reads `projectDir` through an annotated `SurfaceContext`. */
function probeSource(runsIn: 'sandbox' | 'bridge'): string {
  return [
    "import { z } from 'zod';",
    "import type { MethodRecord } from '../../method-types.js';",
    "import type { SurfaceContext } from '../../types.js';",
    'export default {',
    "  tool: 'firestore',",
    "  method: 'probe',",
    `  runsIn: '${runsIn}',`,
    "  sdkOrigin: 'pyric',",
    "  effect: 'read',",
    "  signature: 'probe()',",
    "  description: 'A record compiled only by this test.',",
    '  args: z.object({}),',
    "  operation: 'probe_for_test',",
    '  example: {},',
    '  async handler(_args, ctx: SurfaceContext) {',
    '    return { ok: true, summary: ctx.projectDir };',
    '  },',
    '} satisfies MethodRecord;',
    '',
  ].join('\n');
}

/** The errors the compiler reports for the probe record. */
function probeErrors(runsIn: 'sandbox' | 'bridge'): string[] {
  const configPath = join(PACKAGE_ROOT, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
  const options = { ...config.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  const fileExists = host.fileExists;
  host.fileExists = (path) => path === PROBE_PATH || fileExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) => {
    const isProbe = path === PROBE_PATH;
    if (isProbe) return ts.createSourceFile(path, probeSource(runsIn), languageVersion, true);
    return getSourceFile(path, languageVersion, onError, shouldCreate);
  };
  const program = ts.createProgram([PROBE_PATH], options, host);
  const source = program.getSourceFile(PROBE_PATH)!;
  return program.getSemanticDiagnostics(source)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

let sandboxErrors: string[];
let bridgeErrors: string[];
beforeAll(() => {
  sandboxErrors = probeErrors('sandbox');
  bridgeErrors = probeErrors('bridge');
}, 60_000);

it('refuses a sandbox-side handler that takes the bridge context', () => {
  expect(sandboxErrors.join('\n')).toContain('projectDir');
});

it('accepts the same handler on a bridge-side record', () => {
  expect(bridgeErrors).toEqual([]);
});
