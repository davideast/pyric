import {groups,squares} from './geometry.mjs';

const rows=groups();
const boardIndex=s=>s.charCodeAt(0)-97+(Number(s[1])-1)*10;
const code=(defender,own)=>boardIndex(defender)*100+boardIndex(own);

function membership(square,queen,status){
  const codes=rows.filter(r=>r.slider===square&&r.queen===queen&&r.status===status)
    .flatMap(r=>r.attackers.map(a=>code(r.defender,a))).sort((a,b)=>a-b);
  return codes.length?'key in ['+codes.join(',')+']':'false';
}
function classFor(square,queen){
  return membership(square,queen,'won')+" ? 'won' : "+membership(square,queen,'draw')+" ? 'draw' : 'playing'";
}
export function compactSources() {
  const functions=Object.fromEntries(squares.map(s=>['table'+s,
    'function table'+s+'(key, queen) { return queen ? ('+classFor(s,true)+') : ('+classFor(s,false)+'); }']));
  functions.pairKey=`function pairKey(text, color) {
    let mine = color + 'k,';
    let theirs = color == 'w' ? 'bk,' : 'wk,';
    let a = (text.split(mine)[0] + '!').split(',').size() - 1;
    let d = (text.split(theirs)[0] + '!').split(',').size() - 1;
    return d * 100 + a;
  }`;
  return functions;
}

function tree(lo,hi) {
  if(lo===hi)return 'table'+squares[lo]+'(key, queen)';
  const mid=(lo+hi)>>1;
  return '(index <= '+mid+' ? '+tree(lo,mid)+' : '+tree(mid+1,hi)+')';
}
export function installCompact(rules) {
  const marker='  function chessMove() {';
  const guard='return packedSafe(text, color);';
  if(rules.split(guard).length!==2||rules.split(marker).length!==2)throw Error('unexpected packed binding');
  const helpers=`function compareEnding(text, color, index, queen, status) {
    let key = pairKey(text, color);
    return status == ${tree(0,63)};
  }`;
  // A canonical board contains exactly one king of each color. The guarded
  // three-piece language admits only these kings and the slider at the destination.
  const three="text.matches('[,#]*(?:[wb][kqr][,#]+){3}')";
  const check="(castle || !("+three+") || !(next.board[next.lastMove.to] in [color + 'q',color + 'r']) || compareEnding(text, color, xTo+yTo*8, next.board[next.lastMove.to] == color + 'q', next.status))";
  return rules.replace(guard,'return packedSafe(text, color) && '+check+';').replace(marker,helpers+'\n'+marker);
}
