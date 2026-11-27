import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {sha} from '../../corpus.mjs';
import {immutable, jsonBytes, privateArchive} from './archive.mjs';

export function importReviewed(probe, verifier, archiveArg, runId) {
  assert.match(runId, /^[a-f0-9-]{36}$/);
  const archive = privateArchive(resolve(archiveArg));
  const read = path => JSON.parse(readFileSync(path));
  const completed = read(join(archive, runId, 'completed.json'));
  assert.equal(completed.runId, runId);
  assert.match(completed.digest, /^[a-f0-9]{64}$/);
  const retained = join(archive, completed.digest + '.json');
  const raw = readFileSync(retained);
  assert.equal(sha(raw), completed.digest);
  assert.equal(JSON.parse(raw).runId, runId);
  const results = JSON.parse(execFileSync(process.execPath, [verifier, probe, retained], {encoding:'utf8'}));
  const recipe = readFileSync(join(probe,'recipe.json'));
  assert.deepEqual(Object.keys(results).sort(), JSON.parse(recipe).cases.sort());
  const claim = readFileSync(resolve(probe, '../../../claim.json'));
  const path = 'evidence/' + runId + '.json';
  const authority = JSON.parse(claim).authority;
  assert.ok(['firestore-sdk','rtdb-production'].includes(authority));
  const receipt = {authority, inputDigest: sha(Buffer.concat([claim, Buffer.from([0]), recipe])),
    results, evidence: {path, sha256: completed.digest, pointers: Object.fromEntries(Object.keys(results).map(id => [id, '/rows/' + id + '/decision']))}};
  immutable(join(probe, path), raw, {identicalOk:true});
  immutable(join(probe,'observations',runId + '.json'), jsonBytes(receipt), {identicalOk:true});
  console.log('Imported', Object.keys(results).length, 'authenticated cases from', runId);
}
