import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../../arcade/corpus.mjs';
import {fixedCreatedAt} from '../../../for-of/live/fixtures.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {fresh,afterMove,movePatch} from '../../../chess/verify/document.mjs';
import {checkBundle as checkRelease} from '../fixtures.mjs';

const bytes = readFileSync(new URL('../../reference/budget-case.json',import.meta.url));
assert.equal(sha(bytes),'94151b7613ceb9a9bf9606317df9cc924a76e13b2e5e0df088b3e8e947df8a95');
const row = JSON.parse(bytes);

export function checkBundle(mode,source,digest) {
  assert.ok(mode==='handwritten' || mode==='generated');
  checkRelease(mode, source, digest);
}

export function profile(mode) {
  assert.ok(mode==='handwritten' || mode==='generated');
  return {
    cases:[row],collection:'chess',measureAdmission:true,
    probe:({fen,uci,expected})=>({fen,uci,native:expected}),
    sample(c,writer,opponent) {
      const p=position(c.fen);
      assert.equal(p.turn,'b');
      assert.equal(p.enPassant,-1);
      const board=Object.fromEntries(p.board.map((value,i)=>['abcdefgh'[i%8]+(8-Math.floor(i/8)),value]));
      const before={...fresh(opponent,fixedCreatedAt),guest:writer,currentTurn:'guest',status:'playing',
        board,prevBoard:board,castling:p.castling,prevCastling:p.castling,moveCount:16};
      // afterMove's legality check runs the native chess engine before submit.
      const proposal=movePatch(afterMove(before,c.uci));
      return {before,proposal,after:{...before,...proposal}};
    },
  };
}
