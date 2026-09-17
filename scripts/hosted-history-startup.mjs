/** Bounded startup probe: 100 current documents, increasing durable undo history. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHostedDatabase } from '../packages/cli/dist/serve/hosted/persistence/database.js';
import { validateHostedDatabase } from '../packages/cli/dist/serve/hosted/persistence/validate.js';
import { createHostedRuntime } from '../packages/cli/dist/serve/hosted/runtime.js';
const results = [];
for (const writes of [100, 1000, 10000]) {
  const project = mkdtempSync(join(tmpdir(), 'pyric-history-startup-'));
  const directory = join(project, '.pyric/state/hosted');
  try {
    const database = await openHostedDatabase(directory);
    const docs = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`baseline/doc-${i}`, { index: i, padding: 'x'.repeat(256) }]));
    for (let i = 0; i < writes; i++) {
      const path = `baseline/doc-${i % 100}`;
      const prior = docs[path];
      docs[path] = { index: i, padding: 'x'.repeat(256) };
      database.history.engine.append({ id: i+1, timestamp: new Date().toISOString(), type: 'single', method: 'set', path, allowed: true, auth: null, debugMessages: [], priorDocs: { [path]: prior }, nextDocs: { [path]: docs[path] } }, false);
      database.commitChanges('hosted', new Map([['meta', { version: 3, savedAt: 0, services: {} }], ['00', { docs }]]), []);
    }
    const sequence = database.history.status().durableSequence;
    database.close();
    const samples = [];
    for (let n = 0; n < 3; n++) {
      let at = performance.now();
      const restored = await openHostedDatabase(directory);
      const openMs = performance.now()-at;
      at = performance.now();
      validateHostedDatabase(restored);
      const validationMs = performance.now()-at;
      const undo = restored.history.engine.status();
      restored.close();
      at = performance.now();
      const runtime = await createHostedRuntime({ rules: null, rulesHash: null, storageRules: null, storageRulesHash: null, bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: project }, 'http://127.0.0.1:1', () => {}, project);
      const hostReadyMs = performance.now()-at;
      await runtime.close();
      samples.push({ openMs, validationMs, hostReadyMs, cachedRecords: undo.cachedRecords, cacheBytes: undo.cacheBytes });
    }
    results.push({ documents: 100, writes, sequence, samples });
  } finally { rmSync(project, { recursive: true, force: true }); }
}
const report = JSON.stringify({ node: process.version, results }, null, 2);
const output = process.env.PYRIC_HISTORY_STARTUP_OUTPUT;
const savesReport = output !== undefined;
if (savesReport) writeFileSync(output, report);
console.log(report);
