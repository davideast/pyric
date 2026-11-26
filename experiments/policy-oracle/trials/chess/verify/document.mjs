import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import * as native from '../reference/native.mjs';
import {position} from '../reference/score.mjs';
import {versionNs} from '../../../arcade/corpus.mjs';

const square = i => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
const boardMap = board => Object.fromEntries(board.map((v,i) => [square(i),v]));
const opening = position('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');

export function fresh(host, createdAt, rematchOf) {
  assert.equal(createdAt?.type,'firestore/timestamp/1.0');
  assert.ok(Number.isSafeInteger(createdAt.seconds) && Number.isInteger(createdAt.nanoseconds) &&
    createdAt.nanoseconds >= 0 && createdAt.nanoseconds < 1000000000);
  const board = boardMap(opening.board);
  return {host,guest:'',status:'waiting',currentTurn:'host',winner:'',moveCount:0,board,
    prevBoard:board,castling:'KQkq',prevCastling:'KQkq',enPassant:'',prevEnPassant:'',
    lastMove:{from:'',to:'',promotion:'',extra:[]},createdAt,...(rematchOf && {rematchOf})};
}

export function afterMove(prior, uci, engine=native, checkLegality=true) {
  const board = Array.from({length:64}, (_,i) => prior.board[square(i)]);
  const enPassant = prior.enPassant ? (8 - Number(prior.enPassant[1])) * 8 + 'abcdefgh'.indexOf(prior.enPassant[0]) : -1;
  const pos = {board,turn:prior.currentTurn === 'host' ? 'w' : 'b',enPassant,castling:prior.castling};
  if (checkLegality) assert.ok([...engine.legalMoves(pos)].includes(uci), 'reference rejected move ' + uci);
  const next = engine.apply(pos,uci), result = engine.outcome(next), from = uci.slice(0,2), to = uci.slice(2,4);
  const changed = board.flatMap((piece,i) => piece === next.board[i] ? [] : [square(i)]);
  return {...prior,board:boardMap(next.board),prevBoard:prior.board,
    castling:next.castling,prevCastling:prior.castling,enPassant:next.enPassant === -1 ? '' : square(next.enPassant),
    prevEnPassant:prior.enPassant,currentTurn:prior.currentTurn === 'host' ? 'guest' : 'host',moveCount:prior.moveCount + 1,
    lastMove:{from,to,promotion:uci[4] || '',extra:changed.filter(s => s !== from && s !== to).sort()},
    status:result === 'checkmate' ? 'won' : result === 'stalemate' ? 'draw' : 'playing',winner:result === 'checkmate' ? prior.currentTurn : ''};
}

export function movePatch(doc) {
  return Object.fromEntries(['board','castling','enPassant','prevBoard','prevCastling','prevEnPassant','lastMove','currentTurn','moveCount','status','winner'].map(k=>[k,doc[k]]));
}

export function snapshot(s,path) {
  assert.equal(s.path,path);
  if (s.data === null) assert.deepEqual(s,{path,data:null,version:null});
  else {
    assert.ok(versionNs(s.version) >= versionNs(s.created), 'invalid version at ' + path);
    assert.ok(s.data && typeof s.data === 'object');
  }
}

export function transition(before,after,expected,where) {
  snapshot(before,after.path);
  snapshot(after,before.path);
  assert.deepEqual(after.data,expected,where + ' complete stored document');
  if (isDeepStrictEqual(expected,before.data)) assert.deepEqual(after,before,where + ' unchanged version');
  else if (expected !== null) {
    if (before.data === null) assert.equal(after.version,after.created,where + ' first creation version');
    else {
      assert.equal(after.created,before.created);
      assert.ok(versionNs(after.version) > versionNs(before.version),where + ' newer version');
    }
  }
}

export function protocol(receipt, actors, proof) {
  const {runId,mode} = receipt, {host,guest} = actors;
  const rows = receipt.rows.filter(r => !r.id.startsWith("special-"));
  const game='chess/'+runId, waiting=game+'-waiting', next=game+'-rematch', link='rematches/chess/matches/'+runId;
  const expected = [
    ['opening-counter',host,'DENY',[game]],['create',host,'ALLOW',[waiting]],['cancel-by-guest',guest,'DENY',[waiting]],
    ['cancel-by-host',host,'ALLOW',[waiting]],['open-match',host,'ALLOW',[game]],['join',guest,'ALLOW',[game]],
    ['wrong-turn',guest,'DENY',[game]],['wrong-counter',host,'DENY',[game]],
  ];
  if (mode === 'referee') expected.push(['direct-player-move',host,'DENY',[game]]);
  else expected.push(['f2f3',host,'ALLOW',[game]],['e7e5',guest,'ALLOW',[game]],['g2g4',host,'ALLOW',[game]],['d8h4',guest,'ALLOW',[game]],
    ['terminal-move',host,'DENY',[game]],['pointer-alone',host,'DENY',[link,next,game]],['offer-rematch',host,'ALLOW',[next,link,game]],
    ['duplicate-offer',host,'DENY',[next,link,game]],['join-rematch',guest,'ALLOW',[next]],['resign-rematch',guest,'ALLOW',[next]]);
  const history = new Map();
  let firstPatch;
  assert.deepEqual(rows.map(r=>r.id),expected.map(e=>e[0]),'declared case coverage and order');
  for (const [i,[id,actor,observed,paths]] of expected.entries()) {
    const row=rows[i];
    assert.deepEqual([row.actor,row.observed,row.expected],[actor,observed,observed],id);
    proof(row.proof); proof(row.end);
    if (row.submitted || row.reader) {
      assert.equal(row.reader,actors.observer);
      const set=(path,data,clock=false)=>({op:'set',path,data,...(clock && {serverTimestamp:['createdAt']})});
      const update=(path,data)=>({op:'update',path,data});
      const {createdAt,...opening}=fresh(host,{type:'firestore/timestamp/1.0',seconds:0,nanoseconds:0});
      const rematchPointer=set(link,{game:'chess',match:runId+'-rematch',by:host});
      let ops;
      if (id==='opening-counter') ops=[set(game,{...opening,moveCount:1},true)];
      else if (id==='create' || id==='open-match') ops=[set(paths[0],opening,true)];
      else if (id.startsWith('cancel-')) ops=[{op:'delete',path:waiting}];
      else if (id==='join' || id==='join-rematch') ops=[update(paths[0],{guest,status:'playing'})];
      else if (id==='pointer-alone') ops=[rematchPointer];
      else if (id==='offer-rematch' || id==='duplicate-offer') ops=[set(next,{...opening,rematchOf:runId},true),rematchPointer];
      else if (id==='resign-rematch') ops=[update(next,{status:'resigned',winner:'host'})];
      else {
        if (!firstPatch) firstPatch=movePatch(afterMove(row.before[0].data,'f2f3'));
        let patch=firstPatch;
        if (id==='wrong-counter') patch={...patch,moveCount:2};
        if (/^[a-h][1-8][a-h][1-8]$/.test(id)) patch=movePatch(afterMove(row.before[0].data,id));
        ops=[update(game,patch)];
      }
      assert.deepEqual(row.submitted,ops,id+' exact SDK write intent');
    }
    assert.ok(Date.parse(row.end.verifiedAt) >= Date.parse(row.proof.verifiedAt));
    assert.deepEqual(row.before.map(s=>s.path),paths,id);
    assert.deepEqual(row.after.map(s=>s.path),paths,id);
    for (const [j,path] of paths.entries()) {
      const before=row.before[j],after=row.after[j];
      assert.deepEqual(before,history.get(path) ?? {path,data:null,version:null},id+' prior state at '+path);
      let target=before.data;
      if (observed === 'ALLOW') {
        if (id === 'create' || id === 'open-match') target=fresh(host,after.data?.createdAt);
        else if (id === 'cancel-by-host') target=null;
        else if (id === 'join' || id === 'join-rematch') target={...target,guest,status:'playing'};
        else if (id === 'offer-rematch') {
          if (path === next) target=fresh(host,after.data?.createdAt,runId);
          if (path === link) target={game:'chess',match:runId+'-rematch',by:host};
        } else if (id === 'resign-rematch') target={...target,status:'resigned',winner:'host'};
        else target=afterMove(target,id);
      }
      transition(before,after,target,id+' '+path);
      history.set(path,after);
    }
  }
  return {history, decisions:Object.fromEntries(rows.map(r=>[r.id,r.observed]))};
}
