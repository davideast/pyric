import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {seed} from '../../air-hockey/v1/fixture.mjs';
import {fixtures} from './fixture.mjs';

const receipt = JSON.parse(readFileSync(process.argv[3]));
assert.match(receipt.runId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const id = 'pyric-frame-'+receipt.runId.slice(0,8);
const project = 'projects/803835021738';
const target = {name:project+'/locations/us-central1/instances/'+id,project,
  databaseUrl:'https://'+id+'.firebaseio.com',type:'USER_DATABASE'};
assert.deepEqual(receipt.created,{...target,state:'ACTIVE'});
assert.deepEqual(receipt.cleanup.instance,{...target,state:'DELETED'});
assert.equal(receipt.cleanup.identityDeleted,true);
assert.deepEqual(receipt.cleanup.closed,{status:401,body:{error:'Permission denied'},etag:null});
assert.equal(receipt.project,'digame-mas');
assert.equal(receipt.sdk,'12.19.0');
const {uid} = receipt.identities.host;
assert.match(uid,/^[A-Za-z0-9]{20,40}$/);
assert.deepEqual(receipt.identities.host,{uid,audience:receipt.project,issuer:'https://securetoken.google.com/'+receipt.project,provider:'anonymous'});

const fixture = fixtures['missing-frame'];
const initial = seed(fixture,'guest-fixture');
assert.deepEqual(initial.score,{host:6,guest:6});
const results = {};
for (const profile of ['stock','generated']) {
  const source = readFileSync(new URL('../../air-hockey/v1/'+profile+'.json',import.meta.url));
  assert.deepEqual(receipt.releases[profile],{sourceSha256:sha(source),activeRulesMatchedBeforeAndAfter:true});
  const key = profile+'-missing-frame';
  const {path,relativePath,method,submitted,before,reply,after,decision} = receipt.rows[key];
  assert.equal(path,'airhockey/'+key+'/'+uid);
  assert.equal(relativePath,'');
  assert.equal(method,'PATCH');
  assert.deepEqual(submitted,fixture.value);
  for (const read of [before,after]) {
    assert.equal(read.status,200);
    assert.match(read.etag,/^[A-Za-z0-9+/]+={0,2}$/);
  }
  assert.deepEqual(before.body,initial);
  if (reply.status === 200) {
    const meta = {status:submitted['meta/status'],winner:submitted['meta/winner']};
    assert.deepEqual(reply.body,{score:submitted.score,meta});
    assert.deepEqual(after.body,{...initial,score:submitted.score,meta:{...initial.meta,...meta}});
    assert.notEqual(after.etag,before.etag);
    results[key] = 'ALLOW';
  } else {
    assert.deepEqual(reply,{status:401,body:{error:'Permission denied'},etag:null});
    assert.deepEqual(after,before);
    results[key] = 'DENY';
  }
  assert.equal(decision,results[key]);
}
assert.deepEqual(Object.keys(receipt.rows).sort(),Object.keys(results).sort());
console.log(JSON.stringify(results));
