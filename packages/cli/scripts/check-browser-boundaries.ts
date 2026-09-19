import { build, version } from 'esbuild';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

interface BoundaryIssue {
  rule: 'engine-import' | 'host-import' | 'unbundled-import' | 'bundle-size';
  message: string;
}

function isEngineModule(path: string): boolean {
  const relativePath = path.replaceAll('\\', '/').match(/\/pyric\/(?:src|dist)\/(.+)$/)?.[1];
  const modulePath = relativePath?.replace(/\.[^/.]+$/, '');
  const isOutsidePyric = modulePath === undefined;
  if (isOutsidePyric) return false;
  const isValueWrapper = modulePath.startsWith('rules/simulator/wrappers/');
  const isBrowserAttribution = modulePath.startsWith('sandbox/attribution/');
  const isSharedLeaf = [
    'sandbox/internal/firebase-error',
    'sandbox/internal/client-app',
    // Main adds these browser diagnostics leaves; none owns a service engine.
    'sandbox/internal/ai-evidence',
    'sandbox/internal/sdk-activity',
    'sandbox/internal/sdk-observation',
    'sandbox/internal/sdk-write-activity',
    'sandbox/internal/storage-activity',
    'sandbox/internal/usage-evidence',
    'firestore/sandbox/activity-query-value',
    'firestore/sandbox/activity-structural-identity',
    'rules/indexes/query-analysis',
    'rules/indexes/service-query',
    'firestore/sandbox/activity-value-registry',
    'firestore/sandbox/query-value-registry',
  ].includes(modulePath);
  const isBrowserLeaf = isValueWrapper || isBrowserAttribution || isSharedLeaf;
  if (isBrowserLeaf) return false;
  return modulePath.startsWith('sandbox/') || modulePath.startsWith('rules/') || modulePath.includes('/sandbox/');
}

function isHostModule(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /\/(?:packages\/cli|node_modules\/@pyric\/cli)\/(?:src|dist)\/(?:serve\/(?:hosted\/|worker\/host(?:\/|\.))|bridge\/server\/)/.test(normalized);
}

const requestedEntry = process.argv[2];
const hasNoEntry = requestedEntry === undefined;
if (hasNoEntry) throw new Error('Usage: bun packages/cli/scripts/check-browser-boundaries.ts <entry> <max-bytes>');
const maximumBytes = Number(process.argv[3]);
const hasInvalidBudget = !Number.isSafeInteger(maximumBytes) || maximumBytes < 1;
if (hasInvalidBudget) throw new Error('The browser bundle budget must be a positive integer number of bytes.');

const entry = realpathSync(requestedEntry);
const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  metafile: true,
  minify: true,
  logLevel: 'silent',
});
const bytes = result.outputFiles.reduce((sum, file) => sum + file.contents.length, 0);
const contributors = Object.values(result.metafile.outputs).flatMap((output) =>
  Object.entries(output.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([path]) => resolve(path)),
);
const modules = [...new Set(contributors)].sort();
const issues: BoundaryIssue[] = modules.filter(isEngineModule).map((path) => ({ rule: 'engine-import', message: path }));
issues.push(...modules.filter(isHostModule).map((path): BoundaryIssue => ({ rule: 'host-import', message: path })));
const remainingImports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
issues.push(...remainingImports.map((dependency): BoundaryIssue => ({ rule: 'unbundled-import', message: dependency.path })));
const exceedsBudget = bytes > maximumBytes;
if (exceedsBudget) issues.push({ rule: 'bundle-size', message: `Browser bundle is ${bytes} bytes; the limit is ${maximumBytes} bytes.` });
console.log(JSON.stringify({ entry, bytes, maximumBytes, modules, issues, esbuildVersion: version }, null, 2));
const hasIssues = issues.length > 0;
if (hasIssues) process.exitCode = 1;
