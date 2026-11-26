import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDocument } from '../../../arcade/live/controller/clients.mjs';
import { wireFields } from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import { sha } from '../../../arcade/corpus.mjs';
import { index, move, snapshot } from './snapshots.mjs';
import { refereeServer } from './referee.mjs';

async function click(page,x,y) {
  const b = await page.locator('canvas').boundingBox();
  assert.ok(b); await page.mouse.click(b.x+b.width*x/256,b.y+b.height*y/192);
}
const state = (p,status,ply) => p.waitForFunction(([s,n]) => window.chessView?.status === s && window.chessView.moveCount === n,[status,ply],{timeout:45000});
async function turn(p,uci,black) {
  for (const square of [uci.slice(0,2),uci.slice(2,4)]) {
    const i = black ? 63-index(square) : index(square);
    await click(p,16+(i%8)*16,36+Math.floor(i/8)*16);
  }
}
export async function play(ctx) {
  const {gameBuild,enginePath,config,journal,runId,native,reader,writer,verify} = ctx;
  const engine = await import(pathToFileURL(resolve(enginePath)));
  const metadataUrl = new URL('./chess-match.mjs',pathToFileURL(resolve(enginePath)));
  const matchPolicy = await import(metadataUrl);
  const allowed = new Set([runId]);
  // Synchronize only the two deliberately concurrent fixture requests after both real reads.
  const barrier = Promise.withResolvers(), versions = [];
  const beforeCommit = async (id,ply,version) => {
    if (id !== runId || ply !== 0) return;
    versions.push(version);
    if (versions.length === 2) barrier.resolve();
    const timer = setTimeout(() => barrier.reject(new Error('second concurrent move did not arrive')),30000);
    try {await barrier.promise;} finally {clearTimeout(timer);}
  };
  const srv = await refereeServer({config,gameBuild,engine,matchPolicy,verify,journal,allowed,beforeCommit});
  const {chromium} = await import(process.env.CHESS_PLAYWRIGHT || 'playwright');
  let browser;
  const pages = [], pictures = [], observations = [];
  async function photo(page,name) {
    const file = name + '.png';
    const bytes = await page.screenshot({path:join(journal.directory,file)});
    pictures.push({file,sha256:sha(bytes)});
  }
  async function record(id,paths,check) {
    const proof = await verify();
    const snapshots = await Promise.all(paths.map(p => snapshot(reader,p)));
    const entry = {id,snapshots,proof};
    journal.event('browser-state',entry);
    check(snapshots);
    observations.push(entry);
    return snapshots[0].data;
  }
  try {
    const identity = await writer.auth.currentUser.getIdToken();
    const submit = async (uci,id=runId,ply=0) => {
      const response = await fetch(srv.origin+'/move',{method:'POST',headers:{origin:srv.origin,'content-type':'application/json',authorization:'Bearer '+identity},
        body:JSON.stringify({id,ply,uci})});
      const {requirement} = await response.json();
      return requirement;
    };
    const initial = await snapshot(reader,'chess/'+runId);
    assert.equal(await submit('a1a2'),'legalMove');
    assert.deepEqual(await snapshot(reader,'chess/'+runId),initial);
    const race = await Promise.all([submit('e2e4'),submit('d2d4')]);
    assert.deepEqual(race.slice().sort(),['committed','matchVersion']);
    assert.deepEqual(versions,[initial.version,initial.version]);
    const current = await snapshot(reader,'chess/'+runId);
    assert.deepEqual(current.data,{...initial.data,...native.moveUpdate(initial.data,move(race[0] === 'committed' ? 'e2e4' : 'd2d4'))});
    journal.event('concurrent-admission',{race,initial,current});
    // Moving the pinned rook would expose its own king. Verify refusal at the authoritative write boundary.
    const pinId = runId+'-pinned', pinPath = 'chess/'+pinId;
    const {createdAt:pinTime,...pinFields} = initial.data;
    const pinBoard=Object.fromEntries(Object.keys(initial.data.board).map(s => [s,'']));
    Object.assign(pinBoard,{e1:'wk',e2:'wr',e8:'br',a8:'bk'});
    const pinSeed={...pinFields,board:pinBoard,prevBoard:pinBoard,castling:'',prevCastling:''};
    await createDocument(pinPath,{...wireFields(pinSeed),createdAt:{timestampValue:new Date().toISOString()}});
    const pinnedBefore=await snapshot(reader,pinPath);
    assert.equal(await submit('e2d2',pinId),'legalMove');
    assert.deepEqual(await snapshot(reader,pinPath),pinnedBefore);
    browser = await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
    for (const label of ['white','black']) {
      const context = await browser.newContext({viewport:{width:1024,height:768}});
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror',e => console.log('Browser',label,e.name,e.message.slice(0,180)));
      await page.goto(srv.origin); await page.waitForFunction(() => window.arcadeScene === 'arcade',null,{timeout:60000});
      await click(page,126,141);
    }
    const [white,black] = pages;
    await click(white,73,164);
    await white.waitForURL(/#\/play\/chess\//);
    const id = white.url().split('/').at(-1), path = 'chess/'+id;
    await state(white,'waiting',0);
    await record('browser-create',[path],([s]) => assert.equal(s.data.status,'waiting'));
    await click(black,192,75);
    await black.waitForURL(white.url());
    await Promise.all(pages.map(p => state(p,'playing',0)));
    let previous = await record('browser-join',[path],([s]) => assert.equal(s.data.status,'playing'));
    await photo(white,'opening');
    let ply = 0;
    for (const uci of ['f2f3','e7e5','g2g4','d8h4']) {
      const update = native.moveUpdate(previous,move(uci));
      await turn(ply%2 ? black : white,uci,Boolean(ply%2)); ply++;
      await Promise.all(pages.map(p => state(p,update.status,ply)));
      const expected = {...previous,...update};
      previous = await record('browser-'+uci,[path],([s]) => assert.deepEqual(s.data,expected));
      for (const p of pages) assert.deepEqual(await p.evaluate(() => JSON.parse(JSON.stringify(window.chessView))),expected);
    }
    await photo(black,'checkmate');
    await click(white,126,111);
    await white.waitForURL(url => url.hash.startsWith('#/play/chess/') && !url.hash.endsWith('/'+id));
    const rematch = white.url().split('/').at(-1), next = 'chess/'+rematch, link = 'rematches/chess/matches/'+id;
    await record('browser-rematch-offered',[next,link,path],([m,l,old]) => {
      assert.equal(m.data.rematchOf,id); assert.equal(m.data.status,'waiting');
      assert.deepEqual(l.data,{by:m.data.host,game:'chess',match:rematch}); assert.deepEqual(old.data,previous);
    });
    await click(black,126,111);
    await black.waitForURL(white.url());
    await Promise.all(pages.map(p => state(p,'playing',0)));
    let rematchState = await record('browser-rematch-joined',[next],([m]) => assert.equal(m.data.moveCount,0));
    await turn(white,'e2e4',false);
    await Promise.all(pages.map(p => state(p,'playing',1)));
    const update = native.moveUpdate(rematchState,move('e2e4'));
    rematchState = await record('browser-rematch-e2e4',[next],([s]) => assert.deepEqual(s.data,{...rematchState,...update}));
    await click(black,195,173);
    await Promise.all(pages.map(p => state(p,'resigned',1)));
    await record('browser-rematch-resignation',[next,link,path],([s,l,old]) => {
      assert.deepEqual(s.data,{...rematchState,status:'resigned',winner:'host'});assert.equal(l.data.match,rematch);assert.deepEqual(old.data,previous);
    });
    await photo(white,'rematch-resignation');
    // A legal one-move stalemate from a synthetic endgame, using the same board and move transport.
    const drawId = runId+'-endgame', drawPath = 'chess/'+drawId;
    const {createdAt,...fields} = rematchState;
    delete fields.rematchOf;
    const board = Object.fromEntries(Object.keys(fields.board).map(s => [s,'']));
    Object.assign(board,{a8:'bk',c6:'wk',b5:'wq'});
    const draw = {...fields,...native.initialFields(),board,prevBoard:board,castling:'',prevCastling:'',
      moveCount:0,currentTurn:'host',winner:'',status:'playing'};
    await createDocument(drawPath,{...wireFields(draw),createdAt:{timestampValue:new Date().toISOString()}});
    for (const p of pages) await p.goto(srv.origin+'/#/play/chess/'+drawId);
    await Promise.all(pages.map(p => state(p,'playing',0)));
    const drawBefore = await snapshot(reader,drawPath);
    await turn(white,'b5b6',false);
    await Promise.all(pages.map(p => state(p,'draw',1)));
    await record('browser-stalemate',[drawPath],([s]) => assert.deepEqual(s.data,{...drawBefore.data,...native.moveUpdate(drawBefore.data,move('b5b6'))}));
    await photo(white,'stalemate');
    const promotionId = runId+'-promotion', promotionPath = 'chess/'+promotionId;
    const promotionBoard = Object.fromEntries(Object.keys(board).map(s => [s,'']));
    Object.assign(promotionBoard,{h8:'bk',a1:'wk',a7:'wp'});
    await createDocument(promotionPath,{...wireFields({...draw,board:promotionBoard,prevBoard:promotionBoard}),createdAt:{timestampValue:new Date().toISOString()}});
    for (const p of pages) await p.goto(srv.origin+'/#/play/chess/'+promotionId);
    await Promise.all(pages.map(p => state(p,'playing',0)));
    const promotionBefore = await snapshot(reader,promotionPath);
    await turn(white,'a7a8',false);
    // Four buttons at y=84/104/124/144 (Q, R, B, N). Select the knight.
    await click(white,127,151);
    await Promise.all(pages.map(p => state(p,'playing',1)));
    await record('browser-underpromotion',[promotionPath],([s]) => assert.deepEqual(s.data,
      {...promotionBefore.data,...native.moveUpdate(promotionBefore.data,move('a7a8n'))}));
    return {match:id,rematch,engineSha256:sha(readFileSync(enginePath)),matchPolicySha256:sha(readFileSync(metadataUrl)),
      build:JSON.parse(readFileSync(join(gameBuild,'chess-build.json'))),
      browser:browser.version(),pictures,observations,race,referee:srv.records};
  } finally {
    let cleanupError;
    for (const [i,page] of pages.entries()) {
      if (!existsSync(join(journal.directory,'stalemate.png'))) await photo(page,'last-view-'+i).catch(()=>{});
      try {await page.evaluate(async () => {if (window.chessSignOut) await window.chessSignOut();});}
      catch(e) {journal.event('browser-cleanup-error',{page:i,code:e.name});cleanupError=e;}
    }
    try {await browser?.close();} finally {await srv.close();}
    if (cleanupError) throw new Error('Browser identity cleanup failed',{cause:cleanupError});
  }
}
