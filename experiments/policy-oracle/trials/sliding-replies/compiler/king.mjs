import assert from 'node:assert/strict';
import {attacks,gap} from './sources.mjs';

// Move the king independently to each adjacent playable square. A projection
// with no legal destination still contains K. A successful projection clears
// the old square and leaves Z at the candidate king square, including captures.
export function kingProjections(color) {
  const options=[];
  for(const stride of [1,10,9,11]) {
    const span='('+gap(stride-1)+')';
    options.push("board.replace('K"+span+"[,prnbq]',',$1Z')","board.replace('[,prnbq]"+span+"K','Z$1,')");
  }
  const invalid='(?:[^;]*K[^;]*|[^;]*'+attacks(color).replaceAll('K','Z')+'[^;]*);';
  return `function slideKing${color}(board) {
    let candidates=[${options.join(',\n      ')}].join(';')+';';
    return !candidates.matches('(?:${invalid})*');
  }`;
}

export function linkKingProjections(source) {
  const predicates=/^  function allRefused[wb][0-3]\(records\) \{\n[^\n]+\n  \}\n/gm;
  assert.equal([...source.matchAll(predicates)].length,8);
  const oldKing=/^  function hasKingReply\(text, color\) \{\n(?:[^\n]+\n){3}  \}/m;
  assert.ok(oldKing.test(source));
  const replaced=source.replace(oldKing,`  function hasKingReply(text, color) {
    return color=='w' ? slideKingw(encodew(text)) : slideKingb(encodeb(text));
  }`).replace(predicates,'');
  assert.ok(!replaced.includes('allRefused'),'a retained function still depends on the former king backend');
  return replaced;
}
