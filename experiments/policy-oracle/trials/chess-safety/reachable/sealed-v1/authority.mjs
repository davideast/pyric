import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {positions, freeze} from '../v1/corpus.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export function readHeldOut(dir){
  const pin=(file)=>readFileSync(new URL('../../../chess/reference/'+file,import.meta.url),'utf8').trim().split(/\s+/)[0];
  const archive=readFileSync(join(dir,'holdout.json.gz'));
  assert.equal(sha(archive),pin('holdout-corpus.sha256'));
  const inputSha=sha(readFileSync(join(dir,'holdout-v1.json')));
  assert.equal(inputSha,pin('holdout.sha256'));
  const catalog=JSON.parse(gunzipSync(archive));
  assert.equal(catalog.engine,'python-chess 1.11.2');
  assert.equal(catalog.inputDigest,inputSha);
  return {archiveSha:sha(archive),catalog};
}
export function frozen(dir) {
  const {catalog,archiveSha}=readHeldOut(dir);
  const native=freeze(catalog,archiveSha);
  const publicFens=new Set([...positions()].map(e=>e.row.fen));
  let overlapping=0, challengeMoves=0;
  const counts={};
  for(const {row,first} of positions(catalog.traces)){
    if(!first)continue;
    if(publicFens.has(row.fen))overlapping++;
    if(row.legal.length){
      challengeMoves++;
      const kind=row.outcome;
      counts[kind]=(counts[kind]??0)+1;
    }
  }
  return {...native,overlapsPublicFens:overlapping,newSourceFens:native.uniquePositions-overlapping,
    firstMoveClaimTriplets:challengeMoves,sourceOutcomes:counts};
}
if(import.meta.main)console.log(JSON.stringify(frozen(process.argv[2]),null,2));
