import assert from 'node:assert/strict';
import {attacks} from './sources.mjs';

export const mixedSliderSources = {};
// T marks a capture or interposition square. Search all eight incoming rays. The
// projection vacates the origin, replaces T with a friendly blocker X, and
// preserves every other piece. A record with T left in it never found a mover.
const projections = [], reaches = [], blocks = [];
for (const [stride,piece] of [[1,'[RQ]'],[10,'[RQ]'],[9,'[BQ]'],[11,'[BQ]']]) {
  const gap = stride===1 ? '' : '[^;]{'+(stride-1)+'}';
  const path = '('+gap+'(?:,'+gap+')*)';
  reaches.push(piece+path+'T','T'+path+piece);
  const interior=gap+'(?:,'+gap+')+';
  blocks.push('K'+interior+'T','T'+interior+'K');
  projections.push(`board.replace('${piece}${path}T',',$1X')`,`board.replace('T${path}${piece}','X$1,')`);
}
for (const [side,enemy] of [['w','b'],['b','w']]) {
  mixedSliderSources['captureBoard'+side] = `function captureBoard${side}(text) {
    return text.replace('${side}k,','K').replace('${side}r,','R').replace('${side}b,','B').replace('${side}q,','Q')
      .replace('${side}[pn],','O').replace('${enemy}?([prnbqk#]),','$1');
  }`;
}
mixedSliderSources.safeSliderCapture = `function safeSliderCapture(board,white) {
  let attempts=[${projections.join(',\n      ')}].join(';')+';';
  let attack=white ? '${attacks('w')}' : '${attacks('b')}';
  return !attempts.matches('(?:(?:|[^;]*T[^;]*|[^;]*'+attack+'[^;]*);)*');
}`;

export function linkMixedSlider(source) {
  const start = '  function admittedStatus(';
  const terminal = "packedSafe(text, defender) == (status == 'draw')";
  for(const anchor of [start,terminal]) assert.equal(source.split(anchor).length,2,anchor);
  // At most six empty squares separate a king from a checking slider. Each
  // record retains the checker for interposition, or removes it for capture.
  // Replacing a ray across this list projects the same direction on every board.
  const marks = Array.from({length:6},(_,i) => `(distance>${i+1} ? markBlock(board,king+step*${i+1}) : '')`);
  const helpers = `  function markBlock(board,i) {
    return board[i:i+1]==',' ? board[0:i]+'T'+board[i+1:80] : '';
  }
  function blockRecords(board,king,to) {
    let x=to%10-king%10;
    let y=to / 10 - king / 10;
    let dx=x<0 ? -x : x;
    let dy=y<0 ? -y : y;
    let distance=(dx==0 || dy==0 || dx==dy) ? (dx>dy ? dx : dy) : 0;
    let step=(x==0 ? 0 : x>0 ? 1 : -1)+(y==0 ? 0 : y>0 ? 10 : -10);
    return distance<2 ? '' : [${marks.join(',')}].join(';')+';';
  }
  function sliderAnswer(text,defender,to) {
    let board=defender=='w' ? captureBoardw(text) : captureBoardb(text);
    let i=(int(to[1:2])-1)*10+'abcdefgh'.split(to[0:1])[0].size();
    let piece=board[i:i+1];
    let marked=board[0:i]+'T'+board[i+1:80];
    let canBlock=piece.matches('[rbq]') && marked.matches('.*(?:${blocks.join('|')}).*');
    return piece!='k' && (canBlock || marked.matches('.*(?:${reaches.join('|')}).*')) &&
      safeSliderCapture(canBlock ? marked+';'+blockRecords(board,board.replace('K.*','').size(),i) : marked,defender=='w');
  }
`;
  return source.replace(start, () => helpers+start)
    .replace(terminal, () => terminal+" && !(text.matches('.*'+defender+'[rbq],.*'+defender+'[rbq],.*') && sliderAnswer(text,defender,request.resource.data.lastMove.to))");
}
