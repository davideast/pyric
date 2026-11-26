import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nativeCounts} from './knight-counts.mjs';
import {compileKnight} from './knight.mjs';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {sha} from '../../../arcade/corpus.mjs';

const [pkg,reference,bundle]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(pkg);
const {firestoreRules}=await import(pathToFileURL(resolve(reference,'dist/index.js')));
const frozen=JSON.parse(readFileSync(new URL('knight-counts-native.json',import.meta.url)));
const {rows,hash}=nativeCounts();
assert.equal(hash,frozen.digest);
const candidate=compileKnight(compileFunction,{mode:'standalone',pair:true,all:true});
const source=readFileSync(bundle,'utf8'),anchor='service cloud.firestore {';
assert.equal(source.split(anchor).length,2);
const helper='match /databases/{db}/documents/knights/{id} { allow create: if knightWitness(packNormal(request.resource.data.board),request.resource.data.color); }';
const rule=firestoreRules(source.replace(anchor,anchor+helper));
const result={native:hash,rulesSha:sha(source),positions:rows.length,legal:0,peakByCount:{}};
for(const {color,number,board,knightMoves} of rows) {
  assert.deepEqual(candidate.witnesses(board,color),knightMoves);
  assert.equal(candidate.hasReply(board,color),knightMoves.length>0);
  const expected=knightMoves.length?'ALLOW':'DENY';
  const [r]=rule.simulate([{description:'bounded knight population',path:'knights/position',method:'create',data:{board,color},
    auth:{uid:'player'},expectation:expected}]).cases;
  assert.equal(r.decision,expected);
  assert.ok(!r.unsupported&&!r.resourceLimit&&!r.trace.some(t=>t.verdict==='ERROR'));
  result.peakByCount[number]=Math.max(result.peakByCount[number]??0,r.evaluatedExpressions);
  result.legal+=knightMoves.length;
}
assert.equal(result.legal,frozen.legalKnightMoves);
console.log(JSON.stringify(result,null,2));
