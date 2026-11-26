import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {nativeEvidence} from '../../reference/native.mjs';

// Select a group and the first frozen transition within it. Use only native inputs
// to choose a board; use all three claims for that board, including the wrong label.
const sets = [
  ['interior-v1',['b/mate','w/stalemate','b/king-checked','w/nonking-checked']],
  ['replies-v1',['stalemate-pinned-defender','only-n-move-in-check','only-b-move-in-check','only-p-capture-unchecked','only-r-capture-in-check']],
];
const controls = [], origins = [];
function add(id,fen,uci) {
  const mover = fen.split(' ')[1] === 'w' ? 'host' : 'guest';
  for (const status of ['playing','draw','won'])
    controls.push({id:'holdout-'+id+'-'+status,fen,uci,claim:{status,winner:status === 'won' ? mover : ''}});
}
for (const [directory,groups] of sets) {
  const source = readFileSync(new URL('../'+directory+'/corpus.json.gz',import.meta.url));
  const rows = JSON.parse(gunzipSync(source));
  for (const group of groups) {
    const row = rows.find(item => item.group === group);
    assert.ok(row?.nativeLegal, group);
    const id = directory+'-'+group.replaceAll('/','-');
    origins.push({id,cohort:directory,group,sourceId:row.id,sourceSha256:createHash('sha256').update(source).digest('hex')});
    add(id,row.fen,row.uci);
  }
}
// Cost reducer found during the first KQ/K investigation. The bare king is in
// the corner; changing only the claimed result cannot change its legal replies.
add('black-queen-corner','8/8/8/8/8/1k6/3q4/K7 b - -','d2b2');
const truth = nativeEvidence(controls);
for(let i=0;i<controls.length;i+=3){
  const cases=truth.cases.slice(i,i+3);
  assert.equal(cases.filter(row=>row.nativeAdmission).length,1);
  assert.equal(new Set(cases.map(r=>r.successor)).size,1);
}
const data = {'controls/positions.json':controls,'controls/native.json':truth,'sources.json':origins};
for(const [name,value] of Object.entries(data)) {
  const file = new URL(name,import.meta.url);
  if(process.argv[2] === '--freeze') writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  else assert.deepEqual(JSON.parse(readFileSync(file)),value);
}
console.log(JSON.stringify({moves:controls.length/3,writes:controls.length,allowed:truth.cases.filter(c=>c.nativeAdmission).length}));
