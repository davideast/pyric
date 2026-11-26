import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {position} from '../../chess/reference/score.mjs';
import {squareName} from '../../chess/reference/arcade-reference.ts';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {compile} from './combined.mjs';

const [pkg,corpus,variant='combined-bare-packed-v5']=process.argv.slice(2);
const expected='daad023b62917d4ccce4e758268bfea82b97c3ba525bf2d12f987dc10d5bb0e6';
const bytes=gunzipSync(readFileSync(corpus));
const hash=createHash('sha256').update(bytes).digest('hex');
assert.equal(hash,expected);
const rows=JSON.parse(bytes);
const {compileFunction}=await loadPolicyApi(pkg);
const policy=compile(compileFunction,variant,{mode:'standalone'});
const results={nativeCorpus:hash,submissions:rows.length,uniqueSuccessors:0,eligible:0,outside:0,states:{won:0,draw:0,playing:0}};
const seen=new Set();
for(const row of rows) {
  if(seen.has(row.successor))continue;
  seen.add(row.successor);
  const state=position(row.successor),attacker=state.turn==='w'?'b':'w';
  const board=Object.fromEntries(state.board.map((piece,i)=>[squareName(i),piece]));
  const bare=state.board.every(piece=>piece[0]!==state.turn||piece===state.turn+'k');
  const native={checkmate:'won',stalemate:'draw',playing:'playing'}[row.outcome];
  assert.ok(native,row.outcome);
  assert.equal(policy.bareDefenderStatus(board,attacker),bare?native:null,row.id);
  if(bare){results.eligible++;results.states[native]++;}else results.outside++;
}
results.uniqueSuccessors=seen.size;
console.log(JSON.stringify(results,null,2));
