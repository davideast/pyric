import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import {squareName} from '../../chess/reference/arcade-reference.ts';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {compileMobility} from './adapter.mjs';
import {squares} from '../policy/geometry.mjs';

const [pkg,reference,bundle]=process.argv.slice(2);
const {firestoreRules}=await import(pathToFileURL(resolve(reference,'dist/index.js')));
const {compileFunction}=await loadPolicyApi(pkg);
const {directions}=compileMobility(compileFunction,{mode:'standalone',specialized:true});
const source=readFileSync(bundle,'utf8');
const marker='service cloud.firestore {';
assert.equal(source.split(marker).length,2);
// Per-helper simulation isolates the released predicate from application write
// costs. The full unchanged application is replayed in separate admission tests.
const probe=firestoreRules(source.replace(marker,marker+" match /databases/{db}/documents/probes/{id} { allow create: if hasKingReply(packNormal(request.resource.data.board),request.resource.data.color); }"));
const frozen=readFileSync(new URL('../../chess/reference/public.json.gz',import.meta.url));
assert.equal(sha(frozen),'c2a0ee05ec81ce32998cb58281363a3a96cdee07b950fb697df204283d6e6d71');
const publicRows=JSON.parse(gunzipSync(frozen));
const named=JSON.parse(readFileSync(new URL('native.json',import.meta.url)));
const delta={N:8,NE:9,E:1,SE:-7,S:-8,SW:-9,W:-1,NW:7};
const inputs=new Map();
for(const c of named.cases) inputs.set(c.fen,c.replies);
for(const c of [...publicRows.positions,...publicRows.traces.flatMap(t=>t.rows)]) {
  if(inputs.has(c.fen)) assert.deepEqual(inputs.get(c.fen),c.legal);
  inputs.set(c.fen,c.legal);
}
const results={rulesSha256:sha(source),frozenNative:publicRows.inputDigest,positions:inputs.size,
  directionChecks:0,positive:0,negative:0,kingCaptures:0,castlingAvailable:0};
for(const [fen,legal] of inputs) {
  const p=position(fen),board=Object.fromEntries(p.board.map((v,i)=>[squareName(i),v]));
  const from=squareName(p.board.indexOf(p.turn+'k'));
  const king=legal.filter(m=>m.startsWith(from));
  const adj=king.filter(m=>Math.abs(m.charCodeAt(0)-m.charCodeAt(2))<=1).map(m=>m.slice(2,4)).sort();
  const actual=directions(board,p.turn).map(dir=>squares[squares.indexOf(from)+delta[dir]]).sort();
  assert.deepEqual(actual,adj,fen);
  assert.equal(!!adj.length,!!king.length,fen);
  const expected=king.length?'ALLOW':'DENY';
  const [r]=probe.simulate([{description:fen,method:'create',path:'probes/king',auth:{uid:'reader'},
    data:{board,color:p.turn},expectation:expected}]).cases;
  assert.equal(r.decision,expected,fen);
  assert.ok(!r.unsupported&&!r.resourceLimit&&!r.trace.some(t=>t.verdict==='ERROR'),fen);
  results.directionChecks+=8;
  if(king.length) results.positive++;else results.negative++;
  results.kingCaptures+=adj.filter(s=>board[s]!=='').length;
  if(king.length!==adj.length)results.castlingAvailable++;
}
console.log(JSON.stringify(results,null,2));
