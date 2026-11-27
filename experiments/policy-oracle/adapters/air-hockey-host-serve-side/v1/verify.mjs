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

const native = fixtures['serve-32'];
const initial = seed(native,'guest-fixture');
assert.deepEqual(initial.score,{host:6,guest:6});
assert.deepEqual(native.value.score,{host:7,guest:6});
assert.equal(native.value['meta/status'],'over');
assert.equal(native.value['meta/winner'],'host');
const expectedWrongSide = structuredClone(native);
expectedWrongSide.value.frame.puck.y = 96;
assert.deepEqual(fixtures['serve-96'],expectedWrongSide);
const results = {};
for (const profile of ['stock','generated']) {
  const source = readFileSync(new URL(profile === 'stock' ? '../../air-hockey/v1/stock.json' : '../../air-hockey-match-win/v1/generated.json',import.meta.url));
  assert.deepEqual(receipt.releases[profile],{sourceSha256:sha(source),activeRulesMatchedBeforeAndAfter:true});
  for (const [name,fixture] of Object.entries(fixtures)) {
    const key = profile+'-'+name;
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
      // The REST reply expands slash-delimited patch keys. RTDB then merges
      // these two metadata leaves, preserving the original guest and presence.
      const meta = {status:submitted['meta/status'],winner:submitted['meta/winner']};
      const patch = {score:submitted.score,meta};
      if ('frame' in submitted) patch.frame = submitted.frame;
      const expected = {...initial,...patch,meta:{...initial.meta,...meta}};
      assert.deepEqual(reply.body,patch);
      assert.deepEqual(after.body,expected);
      assert.notEqual(after.etag,before.etag);
      results[key] = 'ALLOW';
    } else {
      assert.deepEqual(reply,{status:401,body:{error:'Permission denied'},etag:null});
      assert.deepEqual(after,before);
      results[key] = 'DENY';
    }
    assert.equal(decision,results[key]);
  }
}
assert.deepEqual(Object.keys(results).sort(),Object.keys(receipt.rows).sort());
console.log(JSON.stringify(results));
