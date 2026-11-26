import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {steps,traces} from '../../fixtures.mjs';
import {afterMove,movePatch,priorPosition} from '../../../../../chess/verify/document.mjs';
import {encode} from '../../../../exploration/v1/corpus.mjs';
import * as native from '../../../../../chess/reference/native.mjs';
import {sample} from '../../../../reference/fixtures.mjs';

const standard=[...steps(traces.find(t=>t.name==='fools-mate'))];
const prefix=standard.slice(0,-1).map(({kind,actor,submitted,after,uci})=>({kind,actor,submitted,after,...(uci&&{uci})}));
const fourth=standard.at(-1);
assert.equal(fourth.before.moveCount,3);
assert.equal(fourth.before.lastMove.from,'g2');
assert.notDeepEqual(fourth.before.board,fourth.before.prevBoard);
const inputs=[],answers=[];
function add(id,kind,uci,before,submitted) {
  const proposal=movePatch(submitted),pending={...before,...proposal};
  assert.deepEqual(pending,submitted);
  inputs.push({id,kind,uci,before,proposal,pending});
  const canonical=afterMove(before,uci,native,true);
  const successor=priorPosition(canonical);
  const replies=native.legalMoves(successor).sort();
  answers.push({id,fen:encode(priorPosition(before)),uci,nativeLegal:native.legalMoves(priorPosition(before)).includes(uci),
    successor:encode(successor),status:canonical.status,winner:canonical.winner,replies,
    nativeAdmission:JSON.stringify(movePatch(canonical))===JSON.stringify(proposal)});
}
add('actual-fourth-ply-win','standard-opening',fourth.uci,fourth.before,fourth.after);
add('actual-fourth-ply-playing','standard-opening',fourth.uci,fourth.before,
  {...fourth.after,status:'playing',winner:''});
const knightRows=JSON.parse(gunzipSync(readFileSync(new URL('../../../../exploration/knight-replies-v1/corpus.json.gz',import.meta.url))));
for(const id of ['knight-reply-477','knight-reply-483']){
  const {fen,uci,claim,nativeAdmission}=knightRows.find(row=>row.id===id);
  const {before,proposal}=sample({fen,uci,claim},'white-player','black-player');
  add(id,'fixed-ply-composed',uci,before,{...before,...proposal});
  assert.equal(answers.at(-1).nativeAdmission,nativeAdmission);
}
const output=(name,data)=>writeFileSync(new URL(name,import.meta.url),JSON.stringify(data,null,2)+'\n');
output('inputs.json',{standardOpeningPrefix:prefix,cases:inputs});
output('native.json',{authority:'pinned native Arcade chess, complete successor, next legal replies and result claim',cases:answers});
