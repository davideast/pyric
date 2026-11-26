import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha} from '../../../arcade/corpus.mjs';
import {fresh,afterMove,snapshot,transition,priorPosition} from './document.mjs';

const absent=path=>({path,data:null,version:null});
export async function browserProof(receipt,j,history,engine,matchPolicy) {
  const b=receipt.browser;
  assert.equal(b.build.arcade,'66e14d4f4b0aeab22c05db8d748704dde053d2e5');
  assert.equal(b.build.engine,b.engineSha256);
  assert.match(b.build.native,/^[a-f0-9]{64}$/);
  assert.ok(Object.hasOwn(b.build.files,'index.html'));
  assert.ok(Object.keys(b.build.files).some(f=>f.startsWith('assets/') && f.endsWith('.js')));
  for(const [file,digest] of Object.entries(b.build.files)) {
    assert.ok(!file.startsWith('/') && !file.split('/').includes('..'));
    assert.match(digest,/^[a-f0-9]{64}$/);
  }
  assert.match(b.browser,/^\d+\.\d+\.\d+\.\d+$/);
  assert.notEqual(b.match,b.rematch);
  for(const id of [b.match,b.rematch]) assert.match(id,/^[a-zA-Z0-9_-]{1,90}$/);
  assert.deepEqual(b.referee,j.all('referee'));
  assert.deepEqual(b.observations,j.all('browser-state'));
  const race=j.only('concurrent-admission');
  const game='chess/'+receipt.runId;
  assert.deepEqual(race.race,b.race);
  assert.deepEqual(b.race.toSorted(),['committed','matchVersion']);
  const winning=b.race[0]==='committed'?'e2e4':'d2d4';
  assert.deepEqual(race.initial,history.get(game));
  const independent=(before,uci)=>{
    const native=afterMove(before,uci);
    assert.deepEqual(afterMove(before,uci,engine,true,matchPolicy),native,uci+' candidate replay agrees with native');
    return native;
  };
  transition(race.initial,race.current,independent(race.initial.data,winning),'race exactly one wins');
  const testRecords=b.referee.filter(record=>record.id===receipt.runId);
  assert.equal(testRecords.length,3);
  const blocked=testRecords.find(r=>r.uci==='a1a2');
  assert.equal(blocked.verdict,'legalMove'); assert.deepEqual(blocked.before,blocked.after);
  assert.equal(blocked.beforeVersion,blocked.afterVersion); assert.deepEqual(blocked.before,race.initial.data);
  for(const [i,uci] of ['e2e4','d2d4'].entries()) {
    const record=testRecords.find(r=>r.uci===uci);
    assert.equal(record.verdict,b.race[i]);
    assert.equal(record.ply,0); assert.deepEqual(record.after,race.current.data);
    assert.equal(record.afterVersion,race.current.version);
    assert.equal(record.comparedVersion,race.initial.version,'actual commit comparison version for '+uci);
    assert.deepEqual([record.beforeVersion,record.before],[race.initial.version,race.initial.data]);
  }
  const path='chess/'+b.match,next='chess/'+b.rematch,pointer='rematches/chess/matches/'+b.match,draw='chess/'+receipt.runId+'-endgame',promotion='chess/'+receipt.runId+'-promotion';
  const prev=new Map();const moves=['f2f3','e7e5','g2g4','d8h4'];
  const names=['create','join',...moves,'rematch-offered','rematch-joined','rematch-e2e4','rematch-resignation','stalemate','underpromotion'];
  assert.deepEqual(b.observations.map(o=>o.id),names.map(n=>'browser-'+n));
  const host=b.observations[0].snapshots[0].data.host,guest=b.observations[1].snapshots[0].data.guest;
  assert.ok(host && guest); assert.notEqual(host,guest);
  const expectedReferee=[];
  for(const [i,obs] of b.observations.entries()) {
    const label=names[i],paths=label==='rematch-offered'||label==='rematch-resignation'?[next,pointer,path]:
      [label==='stalemate'?draw:label==='underpromotion'?promotion:label.startsWith('rematch')?next:path];
    j.proof(obs.proof);
    assert.deepEqual(obs.snapshots.map(s=>s.path),paths);
    for(const s of obs.snapshots) {
      snapshot(s,s.path);
      let before=prev.get(s.path) ?? absent(s.path);
      let target=before.data;
      if(label==='create') target=fresh(host,s.data.createdAt);
      if(label==='join'||label==='rematch-joined') target={...target,guest,status:'playing'};
      if(label==='rematch-offered' && s.path===next) target=fresh(host,s.data.createdAt,b.match);
      if(label==='rematch-offered' && s.path===pointer) target={game:'chess',match:b.rematch,by:host};
      if(label==='rematch-resignation' && s.path===next) target={...target,status:'resigned',winner:'host'};
      let uci=moves.includes(label)?label:label==='rematch-e2e4'?'e2e4':label==='stalemate'?'b5b6':label==='underpromotion'?'a7a8n':null;
      if(uci) {
        const id=s.path.split('/')[1];
        const rec=b.referee.find(r=>r.id===id && r.uci===uci);
        assert.ok(rec,label+' authoritative referee record');
        assert.equal(rec.verdict,'committed');
        if(label==='stalemate' || label==='underpromotion') {
          const board=Object.fromEntries(Object.keys(fresh(host,rec.before.createdAt).board).map(k=>[k,'']));
          Object.assign(board,label==='stalemate'?{a8:'bk',c6:'wk',b5:'wq'}:{h8:'bk',a1:'wk',a7:'wp'});
          const seed={...fresh(host,rec.before.createdAt),guest,status:'playing',board,prevBoard:board,castling:'',prevCastling:''};
          assert.deepEqual(rec.before,seed);
          before={path:s.path,data:seed,created:s.created,version:rec.beforeVersion};
        }
        assert.equal(rec.uid,before.data[before.data.currentTurn]);
        assert.equal(rec.ply,before.data.moveCount);
        assert.deepEqual([rec.beforeVersion,rec.before],[before.version,before.data]);
        target=independent(before.data,uci);
        assert.deepEqual([rec.afterVersion,rec.after],[s.version,target]);
        expectedReferee.push(rec);
      }
      transition(before,s,target,obs.id);
      prev.set(s.path,s);
    }
  }
  const pinId=receipt.runId+'-pinned';
  const pins=b.referee.filter(r=>r.id===pinId);
  assert.equal(pins.length,1);
  const pinned=pins[0];
  assert.equal(pinned.uci,'e2d2');assert.equal(pinned.ply,0);assert.equal(pinned.verdict,'legalMove');
  assert.equal(pinned.uid,j.actors.host);assert.deepEqual(pinned.after,pinned.before);assert.equal(pinned.beforeVersion,pinned.afterVersion);
  const pinBoard=Object.fromEntries(Object.keys(race.initial.data.board).map(s=>[s,'']));
  Object.assign(pinBoard,{e1:'wk',e2:'wr',e8:'br',a8:'bk'});
  assert.deepEqual(pinned.before,{...race.initial.data,createdAt:pinned.before.createdAt,board:pinBoard,prevBoard:pinBoard,castling:'',prevCastling:''});
  assert.deepEqual(b.referee.filter(r=>r.id!==receipt.runId && r.id!==pinId),expectedReferee);
  for(const record of b.referee) {
    j.proof(record.proof);j.proof(record.end);
    const seat=matchPolicy.admit(record.before,record.uid,record.ply);
    if(record.verdict==='legalMove') {
      assert.equal(seat,'ok');
      assert.ok(![...engine.legalMoves(priorPosition(record.before))].includes(record.uci));
    } else if(record.verdict==='committed') assert.equal(seat,'ok');
    else if(record.verdict==='matchVersion') assert.ok(['ok','matchVersion'].includes(seat));
    else assert.equal(record.verdict,seat);
  }
  assert.equal(prev.get(path).data.winner,'guest');
  assert.equal(prev.get(next).data.status,'resigned');
  assert.equal(prev.get(draw).data.status,'draw');
  const namesPNG=['opening','checkmate','rematch-resignation','stalemate'];
  assert.deepEqual(b.pictures.map(q=>q.file),namesPNG.map(n=>n+'.png'));
  assert.equal(new Set(b.pictures.map(p=>p.sha256)).size,namesPNG.length);
  for(const picture of b.pictures) {
    const bytes=readFileSync(join(j.dir,picture.file));
    assert.equal(sha(bytes),picture.sha256);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.ok(bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0);
  }
  return {chromium:b.browser,build:b.build,engineSha256:b.engineSha256,matchPolicySha256:b.matchPolicySha256,screenshots:b.pictures,moveCount:expectedReferee.length,
    race:b.race,checkmateWinner:prev.get(path).data.winner,rematchWinner:prev.get(next).data.winner,
    kingSafety:pinned.verdict,underpromotion:prev.get(promotion).data.board.a8,stalemate:prev.get(draw).data.status,states:b.observations.length};
}
