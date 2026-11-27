import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {privateArchive,immutable,jsonBytes} from '../../../arcade/live/controller/archive.mjs';
import {sha} from '../../../arcade/corpus.mjs';
import {root,directory,variants} from './catalog.mjs';

const [archiveArg,runId] = process.argv.slice(2), archive = privateArchive(resolve(archiveArg));
assert.match(runId,/^[a-f0-9-]{36}$/);
const completed = JSON.parse(readFileSync(join(archive,runId,'completed.json')));
assert.equal(completed.runId,runId);
for (const [family,digest] of Object.entries(completed.receipts)) {
  assert.match(digest,/^[a-f0-9]{64}$/);
  const path = join(archive,digest+'.json'), raw = readFileSync(path);
  assert.equal(sha(raw),digest);
  const record = JSON.parse(raw);
  assert.equal(record.runId,runId);
  assert.equal(record.family,family);
  assert.ok(variants[record.variant].families.includes(family));
  const probe = join(root,directory(family,record.variant));
  const recipe = readFileSync(join(probe,'recipe.json'));
  const claim = readFileSync(resolve(probe,'../../../claim.json'));
  const results = JSON.parse(execFileSync(process.execPath,[join(root,'adapters/ai-jrpg-campaign/v1/verify.mjs'),probe,path],{encoding:'utf8'}));
  assert.deepEqual(Object.keys(results).sort(),JSON.parse(recipe).cases.sort());
  const evidence = 'evidence/'+runId+'.json';
  const obs = {authority:'firestore-sdk',inputDigest:sha(Buffer.concat([claim,Buffer.from([0]),recipe])),results,
    evidence:{path:evidence,sha256:digest,pointers:Object.fromEntries(Object.keys(results).map(id=>[id,'/rows/'+id+'/decision']))}};
  for (const sub of ['evidence','observations']) mkdirSync(join(probe,sub),{recursive:true});
  immutable(join(probe,evidence),raw,{identicalOk:true});
  immutable(join(probe,'observations',runId+'.json'),jsonBytes(obs),{identicalOk:true});
  console.log('Imported',family,record.variant,Object.keys(results).length);
}
