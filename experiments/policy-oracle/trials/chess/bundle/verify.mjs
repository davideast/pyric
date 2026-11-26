import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha } from '../../../arcade/corpus.mjs';

const [arcade, reference] = process.argv.slice(2);
if (!arcade || !reference) throw Error('Usage: bun verify.mjs <pinned Arcade checkout> <installed reference rules package>');
const pinned = '66e14d4f4b0aeab22c05db8d748704dde053d2e5';
const native = 'games/chess/src/chess.ts';
assert.deepEqual(readFileSync(join(arcade, native)), execFileSync('git', ['-C', arcade, 'show', pinned + ':' + native]));
const { initialPosition, squareOf, squareName, applyMove, outcome, legalMoves, isLegal } = await import(pathToFileURL(resolve(arcade, native)));
const { firestoreRules } = await import(pathToFileURL(resolve(reference, 'dist/index.js')));
const names = ['stock', 'compatibility', 'stronger', 'referee'];
const handles = names.map(name => firestoreRules(readFileSync(new URL('artifacts/' + name + '.rules', import.meta.url), 'utf8')));
function position(fen) {
  const [squares, turn, flags, ep] = fen.split(' ');
  const board = [...squares.replaceAll('/', '')].flatMap(p => /\d/.test(p)
    ? Array(Number(p)).fill('') : [(p === p.toUpperCase() ? 'w' : 'b') + p.toLowerCase()]);
  assert.equal(board.length, 64);
  return { board, turn, castling: flags === '-' ? '' : flags, enPassant: ep === '-' ? -1 : squareOf(ep) };
}
const emptyMove = {from:'', to:'', promotion:'', extra:[]};
const map = p => Object.fromEntries(p.board.map((piece,i) => [squareName(i),piece]));
const epName = p => p.enPassant === -1 ? '' : squareName(p.enPassant);
function state(p) {
  return {host:'h',guest:'g',currentTurn:p.turn === 'w' ? 'host' : 'guest',
    status:'playing', winner:'', moveCount:3, board:map(p), prevBoard:map(p), castling:p.castling, prevCastling:p.castling,
    enPassant:epName(p), prevEnPassant:epName(p), lastMove:emptyMove};
}
function turn(p, uci) {
  const from = uci.slice(0,2), to = uci.slice(2,4), promotion = uci.slice(4);
  const m = {from:squareOf(from), to:squareOf(to), ...(promotion ? {promotion} : {})};
  const before = state(p), next = applyMove(p, m), result = outcome(next), board = map(next);
  const extra = Object.keys(board).filter(k => board[k] !== before.board[k] && k !== from && k !== to).sort();
  const after = {...state(next), prevBoard:before.board, prevCastling:p.castling, prevEnPassant:before.enPassant,
    moveCount:before.moveCount + 1, lastMove:{from,to,promotion,extra}, status:result === 'checkmate' ? 'won' : result === 'stalemate' ? 'draw' : 'playing',
    winner:result === 'checkmate' ? before.currentTurn : ''};
  return {before, after, uid:before[before.currentTurn], nativeLegal:isLegal(p,m)};
}
const verdicts = {};
const peak = {};
function run(id, sample, expected) {
  assert.ok(!Object.hasOwn(verdicts,id));
  const row = {description:id,method:'update',path:'chess/example',auth:{uid:sample.uid},
    resource:sample.before,data:sample.after,expectation:'ALLOW'};
  const decisions = handles.map((handle,i) => {
    const [r] = handle.simulate([row]).cases;
    assert.ok(!r.unsupported && !r.resourceLimit, [id,names[i],JSON.stringify(r.unsupported || r.resourceLimit)].join(' '));
    if (!peak[names[i]] || peak[names[i]].evaluatedExpressions < r.evaluatedExpressions) {
      peak[names[i]] = {id, evaluatedExpressions:r.evaluatedExpressions};
    }
    return r.decision;
  });
  assert.deepEqual(decisions, expected.map(x => x ? 'ALLOW' : 'DENY'), id);
  verdicts[id] = decisions;
}
const ok = [1,1,1,0], strongerDenies = [1,1,0,0], allDeny = [0,0,0,0];
const start = initialPosition();
const castle = 'r3k2r/8/8/8/8/8/8/R3K2R';
const white = position(castle + ' w KQkq -'), black = position(castle + ' b KQkq -');
const ep = position('4k3/8/8/3pP3/8/8/8/4K3 w - d6');
const promo = position('1r5k/P7/8/8/8/8/8/K7 w - -');
const longRay = position('8/8/7k/8/8/8/8/Q4K2 w - -');
for (const [id,p,uci] of [
  ['opening-pawn', start, 'e2e4'], ['knight', start, 'g1f3'],
  ['white-kingside',white,'e1g1'], ['white-queenside',white,'e1c1'], ['black-kingside',black,'e8g8'], ['black-queenside',black,'e8c8'],
  ['castle-right-rook-moves',white,'a1a2'],['capture-corner-rook',white,'a1a8'],
  ['en-passant',ep,'e5d6'],['long-line',longRay,'a1a8'],['long-diagonal',longRay,'a1g7'],
  ...['q','r','b','n'].flatMap(kind => [['promote-'+kind,promo,'a7a8'+kind], ['capture-promote-'+kind,promo,'a7b8'+kind]])
]) {
  const sample = turn(p,uci);
  assert.equal(sample.nativeLegal,true,id);
  run(id,sample,ok);
}
// These intentionally exercise the distinction between the two product profiles.
for (const [id,p,uci,decisions] of [
  ['pawn-distance',start,'e2e5',strongerDenies], ['slider-blocked',start,'a1a5',strongerDenies],
  ['knight-shape',start,'b1b3',strongerDenies], ['empty-castle-rights',position(castle + ' w - -'),'e1g1',strongerDenies],
  ['missing-promotion',promo,'a7a8',strongerDenies], ['backward-pawn',position('7k/8/8/8/4P3/8/8/K7 w - -'),'e4e3',strongerDenies],
  ['pinned-slider',position('4r2k/8/8/8/8/8/4R3/4K3 w - -'),'e2d2',ok],
  ['castle-attacked-transit',position('4kr2/8/8/8/8/8/8/4K2R w K -'),'e1g1',ok]
]) {
  const sample = turn(p,uci);
  assert.equal(sample.nativeLegal,false,id);
  run(id,sample,decisions);
}
for (const [id,p,uci,mutate,decisions] of [
  ['ep-successor',start,'e2e4',s=>{s.after.enPassant='';},strongerDenies],
  ['castle-rights-successor',white,'a1a2',s=>{s.after.castling='KQkq';},strongerDenies],
  ['castle-rook-successor',white,'e1g1',s=>{s.after.board.f1='';},strongerDenies],
  ['ep-captured-pawn-successor',ep,'e5d6',s=>{s.after.board.d5='bp';},strongerDenies],
  ['false-terminal-claim',start,'e2e4',s=>{s.after.status='won';s.after.winner='host';},ok],
  ['move-count',start,'e2e4',s=>{s.after.moveCount++;},allDeny],
  ['previous-board',start,'e2e4',s=>{s.after.prevBoard={};},allDeny],
  ['turn-owner',start,'e2e4',s=>{s.uid='g';},allDeny]
]) {
  const s = turn(p,uci);
  mutate(s);
  run(id,s,decisions);
}
const playing = state(start);
const waiting = {...playing, status:'waiting', guest:''};
const joining = {before: waiting, after:{...waiting, status:'playing', guest:'g'}, uid:'g'};
const resigning = {before: playing, after:{...playing, status:'resigned', winner:'guest'}, uid:'h'};
run('join', joining, [1,1,1,1]);
run('resign', resigning, [1,1,1,1]);
for (const [id,s] of [['join-modifies-board',joining], ['resign-modifies-board',resigning]]) {
  run(id,{...s,after:{...s.after,board:{...s.after.board,e2:''}}},allDeny);
}
// Exercise every legal root from dense and sparse positions in the complete linked rules.
for (const [i,p] of [start,white,black,ep,promo,longRay].entries()) {
  for (const m of legalMoves(p)) {
    const uci=squareName(m.from)+squareName(m.to)+(m.promotion??'');
    run('native-'+i+'-'+uci, turn(p,uci), ok);
  }
}
console.log(JSON.stringify({ authority:'local-pinned-reference-evaluator', arcade:pinned,
  sourceSha256:sha(readFileSync(resolve(arcade,native))), profiles:names, cases:Object.keys(verdicts).length, peak, verdicts }, null, 2));
