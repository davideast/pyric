#!/usr/bin/env bun
/**
 * Writes (or checks) the disposable generated projections of the conformance
 * model: the CLI can-i-use bundle, its browser twin, and the assurance
 * verdict lookup. With `--ephemeral`, package prebuilds write only gitignored
 * `.generated` files under `packages/cli/src/` and leave committed files
 * untouched (#1417). The model itself lives in conformance-model.ts and never
 * reads these outputs back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_TS_PATH, renderConformanceVerdicts } from './conformance-verdicts.ts';
import { renderBrowserQuery, renderCliQuery } from './can-i-use-template.ts';
import { renderDocsProjectionModule } from './generate-docs.ts';
import { deriveConformanceModel } from './conformance-model.ts';
import {
  RULES_MODULE_CAPABILITIES_PATH,
  renderRulesModuleCapabilities,
} from './rules-module-capabilities.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_QUERY_PATH = join(HERE, '..', '..', 'cli', 'src', 'conformance', '.generated', 'can-i-use.ts');
export const CLI_BROWSER_QUERY_PATH = join(HERE, '..', '..', 'cli', 'src', 'conformance', '.generated', 'can-i-use-browser.ts');
export const CLI_DOCS_PATH = join(HERE, '..', '..', 'cli', 'src', 'conformance', '.generated', 'conformance-docs.ts');

export interface ProjectionEntry {
  path: string;
  source: string;
  ephemeral: boolean;
}

function readExisting(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8');
}

export function writeProjectionOutputs(
  entries: readonly ProjectionEntry[],
  options: { ephemeralOnly?: boolean } = {},
): string[] {
  const ephemeralOnly = options.ephemeralOnly === true;
  const written: string[] = [];
  for (const entry of entries) {
    if (ephemeralOnly && !entry.ephemeral) {
      continue;
    }
    if (readExisting(entry.path) === entry.source) {
      continue;
    }
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, entry.source);
    written.push(entry.path);
  }
  return written;
}

if (import.meta.main) {
  const model = await deriveConformanceModel();
  const rendered = renderCliQuery(model);
  const browserRendered = renderBrowserQuery(model);
  const docsRendered = renderDocsProjectionModule(model);
  const verdicts = renderConformanceVerdicts(model.assuranceNodeVerdicts);
  const rulesModuleCapabilities = renderRulesModuleCapabilities();
  const entries: readonly ProjectionEntry[] = [
    { path: CLI_QUERY_PATH, source: rendered, ephemeral: true },
    { path: CLI_BROWSER_QUERY_PATH, source: browserRendered, ephemeral: true },
    { path: CLI_DOCS_PATH, source: docsRendered, ephemeral: true },
    { path: RUNTIME_TS_PATH, source: verdicts, ephemeral: true },
    { path: RULES_MODULE_CAPABILITIES_PATH, source: rulesModuleCapabilities, ephemeral: false },
  ];
  if (process.argv.includes('--write')) {
    const ephemeralOnly = process.argv.includes('--ephemeral');
    const written = writeProjectionOutputs(entries, { ephemeralOnly });
    for (const path of written) {
      console.log(`Wrote ${path}`);
    }
  } else if (process.argv.includes('--check')) {
    for (const entry of entries) {
      const current = readExisting(entry.path);
      if (current !== entry.source) {
        console.error(`Generated conformance projection is missing or stale: ${entry.path}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`Conformance model: ${model.supports.length} developer feature result(s), ${Buffer.byteLength(rendered)} bytes`);
  console.log(`Browser query projection: ${Buffer.byteLength(browserRendered)} bytes raw, ${gzipSync(browserRendered).byteLength} bytes gzip`);
  const counts = { supported: 0, qualified: 0, unsupported: 0 };
  for (const verdict of Object.values(model.assuranceNodeVerdicts)) {
    counts[verdict]++;
  }
  console.log(`Assurance verdicts: ${Object.keys(model.assuranceNodeVerdicts).length} nodes (${counts.supported} supported, ${counts.qualified} qualified, ${counts.unsupported} unsupported)`);
  console.log(`Generated verdict lookup: ${Buffer.byteLength(verdicts)} bytes raw, ${gzipSync(verdicts).byteLength} bytes gzip`);
}
