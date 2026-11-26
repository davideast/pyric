import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import * as native from '../../chess/reference/native.mjs';
import {fresh, afterMove, movePatch} from '../../chess/verify/document.mjs';

const frozen = JSON.parse(readFileSync(new URL('../reference/cases.json',import.meta.url)));
export const cases = frozen.rook.map(({id,fen,from,to,expected}) => ({
  id,fen,uci:from+to,expected:expected ? 'ALLOW':'DENY',
}));

export const handwritten = readFileSync(new URL('../../chess/bundle/artifacts/stronger.rules',import.meta.url),'utf8');
const qualified = JSON.parse(readFileSync(new URL('../../chess/verify/releases/stronger.json',import.meta.url)));
assert.equal(sha(handwritten),qualified.report.rulesSha256);

export function checkBundle(mode,source,expectedDigest) {
  assert.equal(sha(source),expectedDigest,'supplied bundle digest');
  if (mode === 'handwritten') {
    assert.equal(source,handwritten,'must use previously qualified full Arcade release');
  } else {
    assert.equal(mode,'generated');
    const helper = /^  function _games_chess_chess_helpers__pathClear\(board, x, y, dx, dy\) \{[^{}]*?^  \}/gm;
    assert.equal([...source.matchAll(helper)].length,1,'expected a single generated pathClear function');
    assert.equal([...handwritten.matchAll(helper)].length,1);
    assert.equal(source.replace(helper,'<pathClear>'),handwritten.replace(helper,'<pathClear>'),
      'only pathClear may change in the complete Arcade ruleset');
  }
}

export const fixedCreatedAt = {type:'firestore/timestamp/1.0',seconds:1767225600,nanoseconds:0};
export function sample(c,host,guest) {
  const p = position(c.fen);
  const board = Object.fromEntries(p.board.map((piece,i) => ['abcdefgh'[i%8]+(8-Math.floor(i/8)),piece]));
  assert.equal(native.legalMoves(p).includes(c.uci),c.expected === 'ALLOW',c.id+' native legal list');
  const before = {...fresh(host,fixedCreatedAt), guest, status:'playing', moveCount:16,
    board,prevBoard:board,castling:'',prevCastling:'',enPassant:'',prevEnPassant:''};
  // Construct the same plausible successor even for the two blocked paths.
  const proposal = movePatch(afterMove(before,c.uci,native,false));
  return {before,proposal,after:c.expected === 'ALLOW' ? {...before,...proposal} : before};
}
