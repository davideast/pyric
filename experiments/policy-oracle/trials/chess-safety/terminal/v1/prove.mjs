import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ending,touching,groups} from './geometry.mjs';
const truth=JSON.parse(readFileSync(new URL('native.json',import.meta.url)));
const hash=createHash('sha256'), tally={playing:0,checkmate:0,stalemate:0};
for(const color of ['w','b'])for(const piece of ['r','q'])
  for(let s=0;s<64;s++)for(let d=0;d<64;d++)for(let a=0;a<64;a++){
    if(s===d||s===a||touching(a,d))continue;
    const outcome={won:'checkmate',draw:'stalemate',playing:'playing'}[ending(s,d,a,piece==='q')];
    hash.update([color,piece,s,d,a,outcome].join(' ')+'\n');
    tally[outcome]++;
  }
assert.deepEqual(tally,truth.tally);
assert.equal(hash.digest('hex'),truth.digest);
console.log(JSON.stringify({...truth,terminalGroups:groups().length},null,2));
