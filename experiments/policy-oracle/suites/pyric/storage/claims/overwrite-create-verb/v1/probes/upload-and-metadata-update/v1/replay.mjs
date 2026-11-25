import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = pathToFileURL(join(process.env.ORACLE_ROOT, 'arcade/runtime/package.json')).href;
const { parseStorageRules, evaluateStorageRules } =
  await import(import.meta.resolve('@pyric/rules/internal/storage', runtime));
const rules = parseStorageRules(readFileSync(new URL('storage.rules', import.meta.url), 'utf8'));
const { bucket, cases, seed } = JSON.parse(readFileSync(new URL('operations.json', import.meta.url), 'utf8'));

function replay(classifyUpload) {
  const results = {};
  for (const [id, op] of Object.entries(cases)) {
    const path = 'b/' + bucket + '/o/' + op.path;
    const stored = op.seeded ? { size: seed.bytes.length, contentType: seed.contentType } : null;
    let method, size;
    if (op.kind === 'metadataUpdate') {
      assert.ok(stored);
      method = 'update';
      size = stored.size;
    } else {
      assert.equal(op.kind, 'upload');
      method = classifyUpload(stored);
      size = op.bytes.length;
    }
    const input = {
      request: { path, method, auth: null, resource: { ...op.fields, size } },
      resource: stored,
    };
    const result = evaluateStorageRules(rules, input);
    assert.ok(!result.resourceLimit, 'unexpected evaluator resource limit for ' + id);
    results[id] = result.allowed ? 'ALLOW' : 'DENY';
  }
  return results;
}

// A byte upload enters the native evaluator as a write with an incoming object.
// The alternate classifier routes an upload over existing bytes to metadata update.
const candidate = replay(() => 'write');
const mutant = replay(stored => stored ? 'update' : 'write');
console.log(JSON.stringify({ candidate, mutant }));
