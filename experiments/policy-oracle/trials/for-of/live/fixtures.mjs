import assert from 'node:assert/strict';
import {ordered,checkOrderedBundle} from './ordered.mjs';
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

const mapPrefix = '// @pyric-source-map: ';
const rayHelper = "  function rayEmpty(board, files, ranks, x, y) {\n    return board[files[x] + ranks[y]] == '';\n  }\n";
const pathHelper = /^  function _games_chess_chess_helpers__pathClear\(board, x, y, dx, dy\) \{[^{}]*?^  \}/gm;

function linkedParts(source) {
  const lines = source.trimEnd().split('\n');
  const comment = lines.pop();
  assert.ok(comment.startsWith(mapPrefix),'expected the Arcade linker source map on the last line');
  const entries=JSON.parse(comment.slice(mapPrefix.length));
  assert.ok(Array.isArray(entries) && entries.length);
  const mappings=[];
  for(const e of entries) {
    assert.ok(Number.isInteger(e.generatedLine) && e.generatedLine>0 && e.generatedLine<=lines.length);
    assert.ok(Number.isInteger(e.authoredLine) && e.authoredLine>0);
    assert.ok(Number.isInteger(e.authoredCol) && e.authoredCol>0);
    assert.equal(typeof e.authoredFile,'string');
    if(e.authoredFile!=='../games/chess/chess-helpers') mappings.push({...e,generatedLine:lines[e.generatedLine-1]});
  }
  return {code:lines.join('\n'),mappings};
}

export function checkBundle(mode,source,expectedDigest) {
  assert.equal(sha(source),expectedDigest,'supplied bundle digest');
  if (mode === 'ordered-errors') {
    checkOrderedBundle(linkedParts(source).code);
  } else if (mode === 'handwritten') {
    assert.equal(source,handwritten,'must use previously qualified full Arcade release');
  } else {
    assert.equal(mode,'generated');
    const prior=linkedParts(handwritten), next=linkedParts(source);
    assert.deepEqual(next.mappings,prior.mappings,'source mapping for unrelated modules must still point to the same code');
    assert.equal(prior.code.split(rayHelper).length,2,'exact known linked helper definition');
    assert.equal([...next.code.matchAll(pathHelper)].length,1,'expected a single generated pathClear function');
    assert.equal([...prior.code.matchAll(pathHelper)].length,1);
    const treeShaken = next.code.includes(rayHelper) ? prior.code : prior.code.replace(rayHelper,'');
    assert.equal(next.code.replace(pathHelper,'<pathClear>'),treeShaken.replace(pathHelper,'<pathClear>'),
      'only pathClear and removal of its former rayEmpty dependency may affect executable Arcade rules');
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

export function profile(mode) {
  if (mode === 'ordered-errors') return ordered;
  assert.ok(mode==='handwritten' || mode==='generated');
  return {cases,collection:'chess',probe:c=>({fen:c.fen,uci:c.uci}),sample};
}
