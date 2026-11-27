import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {fixtures,seed} from './fixture.mjs';

const receipt = JSON.parse(readFileSync(process.argv[3]));
assert.match(receipt.runId,/^[a-f0-9-]{36}$/);
const name = 'pyric-frame-'+receipt.runId.slice(0,8);
const project = 'projects/803835021738';
const instance = {name:project+'/locations/us-central1/instances/'+name, project,
  databaseUrl:'https://'+name+'.firebaseio.com',type:'USER_DATABASE'};
assert.deepEqual(receipt.created,{...instance,state:'ACTIVE'});
assert.deepEqual(receipt.cleanup.instance,{...instance,state:'DELETED'});
assert.equal(receipt.cleanup.identityDeleted,true);
assert.deepEqual(receipt.cleanup.closed,{status:401,body:{error:'Permission denied'},etag:null});
assert.equal(receipt.project,'digame-mas');
assert.equal(receipt.sdk,'12.19.0');
const {uid} = receipt.identities.host;
assert.match(uid,/^[A-Za-z0-9]{20,40}$/);
assert.deepEqual(receipt.identities.host,{uid,audience:receipt.project,issuer:'https://securetoken.google.com/'+receipt.project,provider:'anonymous'});
const results = {};
for (const profile of ['stock','generated']) {
  const digest = sha(readFileSync(new URL(profile+'.json',import.meta.url)));
  assert.deepEqual(receipt.releases[profile],{sourceSha256:digest,activeRulesMatchedBeforeAndAfter:true});
  for (const [id,fixture] of Object.entries(fixtures)) {
    const key = profile+'-'+id;
    const {path,method,relativePath,submitted,before,reply,after,decision} = receipt.rows[key];
    assert.equal(path,'airhockey/'+key+'/'+uid);
    assert.equal(relativePath,fixture.path);
    assert.equal(method,fixture.method === 'update' ? 'PATCH' : 'PUT');
    assert.deepEqual(submitted,fixture.value);
    assert.deepEqual(before.body,seed(fixture,'guest-fixture'));
    for (const read of [before,after]) {
      assert.equal(read.status,200);
      assert.match(read.etag,/^[A-Za-z0-9+/]+={0,2}$/);
    }
    if (reply.status === 200) {
      assert.deepEqual(reply.body,submitted);
      assert.deepEqual(after.body,{...before.body,...(method === 'PATCH' ? submitted : {frame:submitted})});
      assert.notEqual(before.etag,after.etag);
      results[key] = 'ALLOW';
    } else {
      assert.equal(reply.status,401);
      assert.deepEqual(reply.body,{error:'Permission denied'});
      assert.deepEqual(after,before);
      results[key] = 'DENY';
    }
    assert.equal(decision,results[key]);
  }
}
assert.deepEqual(Object.keys(receipt.rows).sort(),Object.keys(results).sort());
console.log(JSON.stringify(results));
