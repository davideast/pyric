import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const runtime = pathToFileURL(join(process.env.ORACLE_ROOT, 'arcade/runtime/package.json')).href;
const { rtdbRules } = await import(import.meta.resolve('@pyric/rules', runtime));
const source = JSON.parse(readFileSync(new URL('database.rules.json', import.meta.url), 'utf8'));
const operations = JSON.parse(readFileSync(new URL('operations.json', import.meta.url), 'utf8'));

function replay(rules) {
  const handle = rtdbRules(rules);
  return Object.fromEntries(Object.entries(operations).map(([id, operation]) => {
    // The front door requires an expectation for its pass count. Read its absolute verdict.
    const [row] = handle.simulate([{ ...operation, description: id, expectation: 'ALLOW' }]).cases;
    assert.ok(!row.unsupported && row.trace.length > 0, row.reason);
    return [id, row.decision];
  }));
}

const wrongBinding = structuredClone(source);
const messageRule = wrongBinding.rules['r63-ancestor-write-data-newdata'].msgs.$m;
assert.ok(messageRule['.write'].includes('newData.child('));
// Give the ancestor rule its pre-write snapshot for the newData lookup.
messageRule['.write'] = messageRule['.write'].replace('newData.child(', 'data.child(');
console.log(JSON.stringify({ candidate: replay(source), mutant: replay(wrongBinding) }));
