import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../arcade/corpus.mjs';
import {checkRows} from '../../for-of/live/evidence.mjs';
import {reviewedPlan} from '../../chess-safety/live/fixtures.mjs';
import {sample} from '../../chess-safety/reference/fixtures.mjs';

export const previousDigest='5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380';
export const previousPlans=['comma-chess-safety-full','comma-held-rook-promotion'];
export const roles={host:'host',guest:'guest',observer:'observer'};
export const root=new URL('./',import.meta.url);
export const readJSON=file=>JSON.parse(readFileSync(file));
export const digestPattern=/^[a-f0-9]{64}$/;

export function versionDirectory(digest) {
  assert.match(digest,digestPattern);
  return new URL('releases/'+digest+'/',root);
}

export function signedOperands(row) {
  return {id:row.id,actor:row.actor,reader:row.reader,probe:row.probe,
    before:row.before.map(({path,data})=>({path,data})),submitted:row.submitted};
}

export function inputs(includeQueenBishop=false) {
  const all=new Map(),prior=new Map(),origins={};
  for (const name of previousPlans) {
    const profile=reviewedPlan(name);
    assert.equal(profile.plan.rulesSha256,previousDigest);
    const spec=profile.fixtures.profile(name);
    const file=new URL(name+'.json.gz',profile.receipts),bytes=readFileSync(file);
    const pin=readJSON(new URL(name+'.pin.json',profile.receipts));
    assert.equal(sha(bytes),pin.receiptGzipSha256);
    const receipt=JSON.parse(gunzipSync(bytes));
    assert.equal(receipt.privateReceipt,pin.controllerSha256);
    checkRows(receipt.rows,roles,id=>'chess/match-'+id,name,profile.fixtures);
    origins[name]=sha(bytes);
    for(const [index,c] of spec.cases.entries()) {
      assert.ok(!all.has(c.id),c.id);
      all.set(c.id,{c,spec,batch:profile.batches.get(c.id)});
      prior.set(c.id,signedOperands(receipt.rows[index]));
    }
  }
  assert.equal(prior.size,190);
  const added=[],focused=[];
  const families=includeQueenBishop?['rook','bishop','queen','queen-bishop']:['rook','bishop','queen'];
  for(const piece of families) {
    const path=new URL('../native/'+piece+'/positions.json',root), bytes=readFileSync(path);
    origins[piece]=sha(bytes);
    for(const c of JSON.parse(bytes)) {
      assert.deepEqual(Object.keys(c).sort(),['claim','fen','id','uci']);
      assert.match(c.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      if(piece==='rook') {
        assert.ok(prior.has(c.id));
        assert.deepEqual(c,all.get(c.id).c);
      } else {
        assert.ok(!all.has(c.id),c.id);
        const spec={sample,probe:({id,...value})=>value};
        all.set(c.id,{c,spec,batch:piece});
        added.push(c.id);
      }
      focused.push(c.id);
    }
  }
  assert.equal(focused.length,new Set(focused).size);
  // Exercise all newly frozen slider positions during the first release window.
  const order=[...new Set([...focused,...prior.keys()])];
  assert.equal(order.length,prior.size+added.length);
  return {all,prior,origins,order};
}

function binding(source) {
  const rows=source.trimEnd().split('\n');
  if(rows.at(-1).startsWith('// @pyric-source-map: ')) rows.pop();
  const i=rows.findIndex(s=>s.trim()==='match /databases/{database}/documents {');
  assert.ok(i>=0,'expected full Arcade service');
  return rows.slice(i).join('\n');
}

export function verifySource(source,digest) {
  assert.equal(sha(source),digest,'reviewed candidate source changed');
  const {bundle}=reviewedPlan(previousPlans[0]);
  assert.equal(binding(source),binding(readFileSync(bundle,'utf8')),'Arcade resource match and allow bindings changed');
}

export function buildPlan(data,digest) {
  assert.match(digest,digestPattern);
  const chunks=[];
  const pair=data.order.filter(id=>data.all.get(id).batch==='queen-bishop');
  const original=data.order.filter(id=>data.all.get(id).batch!=='queen-bishop');
  assert.equal(original.length,238,'historical release corpus changed');
  assert.equal(pair.length,data.origins['queen-bishop']?4:0,'queen-and-bishop corpus changed');
  if(pair.length) chunks.push({name:'sliding-queen-bishop',ids:pair});
  for(let i=0; i<original.length; i+=120) {
    chunks.push({name:'sliding-part-'+(i/120+1),ids:original.slice(i,i+120)});
  }
  return {version:pair.length?2:1,rulesSha256:digest,previousRulesSha256:previousDigest,
    originalCases:data.prior.size,expectedCases:data.order.length,inputDigests:data.origins,chunks};
}

export function chunkFixtures(data,plan,name) {
  const chunk=plan.chunks.find(c=>c.name===name);
  assert.ok(chunk,'no such reviewed release chunk');
  const cases=chunk.ids.map(id=>data.all.get(id).c);
  return {
    checkBundle(mode,source,digest) {
      assert.equal(mode,name);assert.equal(digest,plan.rulesSha256);
      verifySource(source,digest);
    },
    profile(mode) {
      assert.equal(mode,name);
      return {collection:'chess',measureAdmission:true,cases,
        sample:(c,host,guest)=>data.all.get(c.id).spec.sample(c,host,guest),
        probe:c=>data.all.get(c.id).spec.probe(c)};
    },
  };
}
