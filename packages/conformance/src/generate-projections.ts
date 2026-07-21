#!/usr/bin/env bun
/**
 * Writes (or checks) the disposable generated projections of the conformance
 * model: the CLI can-i-use bundle, its browser twin, and the assurance
 * verdict lookup. The model itself lives in conformance-model.ts and never
 * reads these outputs back.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

if (import.meta.main) {
  const model = await deriveConformanceModel();
  const rendered = renderCliQuery(model);
  const browserRendered = renderBrowserQuery(model);
  const docsRendered = renderDocsProjectionModule(model);
  const verdicts = renderConformanceVerdicts(model.assuranceNodeVerdicts);
  const rulesModuleCapabilities = renderRulesModuleCapabilities();
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(CLI_QUERY_PATH), { recursive: true });
    mkdirSync(dirname(RUNTIME_TS_PATH), { recursive: true });
    writeFileSync(CLI_QUERY_PATH, rendered);
    writeFileSync(CLI_BROWSER_QUERY_PATH, browserRendered);
    writeFileSync(CLI_DOCS_PATH, docsRendered);
    writeFileSync(RUNTIME_TS_PATH, verdicts);
    writeFileSync(RULES_MODULE_CAPABILITIES_PATH, rulesModuleCapabilities);
    console.log(`Wrote ${CLI_QUERY_PATH}`);
    console.log(`Wrote ${CLI_BROWSER_QUERY_PATH}`);
    console.log(`Wrote ${CLI_DOCS_PATH}`);
    console.log(`Wrote ${RUNTIME_TS_PATH}`);
    console.log(`Wrote ${RULES_MODULE_CAPABILITIES_PATH}`);
  } else if (process.argv.includes('--check')) {
    for (const [path, source] of [
      [CLI_QUERY_PATH, rendered],
      [CLI_BROWSER_QUERY_PATH, browserRendered],
      [CLI_DOCS_PATH, docsRendered],
      [RUNTIME_TS_PATH, verdicts],
      [RULES_MODULE_CAPABILITIES_PATH, rulesModuleCapabilities],
    ] as const) {
      let current = '';
      try { current = readFileSync(path, 'utf8'); } catch { /* reported below */ }
      if (current !== source) {
        console.error(`Generated conformance projection is missing or stale: ${path}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`Conformance model: ${model.supports.length} developer feature result(s), ${Buffer.byteLength(rendered)} bytes`);
  console.log(`Browser query projection: ${Buffer.byteLength(browserRendered)} bytes raw, ${gzipSync(browserRendered).byteLength} bytes gzip`);
  const counts = { supported: 0, qualified: 0, unsupported: 0 };
  for (const verdict of Object.values(model.assuranceNodeVerdicts)) counts[verdict]++;
  console.log(`Assurance verdicts: ${Object.keys(model.assuranceNodeVerdicts).length} nodes (${counts.supported} supported, ${counts.qualified} qualified, ${counts.unsupported} unsupported)`);
  console.log(`Generated verdict lookup: ${Buffer.byteLength(verdicts)} bytes raw, ${gzipSync(verdicts).byteLength} bytes gzip`);
}
