#!/usr/bin/env bun
/**
 * Generate the JSON files the playground-debug replay driver expects
 * from plain `.tsx` + `.rules` fixtures next to this script. Keeps the
 * sources editable as code rather than buried in escaped JSON.
 *
 * Usage:
 *   bun examples/playground-next/scripts/fixtures/build.ts
 *
 * Writes one `<name>.json` per fixture pair found in this directory.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const fixtures = readdirSync(HERE)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.replace(/\.tsx$/, ''));

for (const name of fixtures) {
  const appPath = join(HERE, `${name}.tsx`);
  const rulesPath = join(HERE, `${name}.rules`);
  const outPath = join(HERE, `${name}.json`);

  const appSource = readFileSync(appPath, 'utf8');
  let rulesSource = '';
  try {
    rulesSource = readFileSync(rulesPath, 'utf8');
  } catch {
    // Rules sibling is optional — fixtures that don't gate on rules
    // can omit it; the replay driver falls back to whatever rules
    // the previous test deployed (typically the open-default).
  }

  const replayDoc = {
    role: 'assistant',
    toolCalls: [
      ...(rulesSource
        ? [{ name: 'writeRules', args: { source: rulesSource } }]
        : []),
      { name: 'writeApp', args: { source: appSource } },
    ],
  };

  writeFileSync(outPath, JSON.stringify(replayDoc, null, 2));
  console.log(`wrote ${name}.json (${appSource.length} chars app, ${rulesSource.length} chars rules)`);
}
