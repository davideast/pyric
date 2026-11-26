import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lineSources,linePath,compactRights,dropRights} from './line-search.mjs';
import {compactPathSources,compactValidation,compactPath,compactAdmission} from './compact.mjs';
import {packedSources,packedGuard,packedPredict} from './packed.mjs';
import {optimizeValidation,optimizeApplication} from './optimized.mjs';
import {squares, geometricSources, selectSquare} from './geometry.mjs';

const read = path => readFileSync(new URL(path,import.meta.url),'utf8');
const horizontalSource = () => read('../../king-safety/policy/horizontal-path.policy');
export const variants = ['pins','attacks','castle','optimized','packed','packed-v2','packed-v3','packed-v4','packed-v5'];

function sourcesFor(variant) {
  if (['packed-v2','packed-v3','packed-v4','packed-v5'].includes(variant)) return {...packedSources(true),...compactPathSources(),...(variant==='packed-v5' ? lineSources() : {})};
  return variant === 'packed' ? packedSources() : geometricSources(variant);
}

export function compile(compileFunction, variant = 'castle', {mode='both'} = {}) {
  const sources = {...sourcesFor(variant), horizontalPathClear:horizontalSource()};
  const compiled = Object.fromEntries(Object.entries(sources).map(([name,source])=>[name,compileFunction(source)]));
  const modules = mode==='standalone' ? {} : Object.fromEntries(Object.entries(compiled).map(([k,fn])=>[k,fn.firestoreModule()]));
  function predict({resource:old, data:next}) {
    if (variant.startsWith('packed')) return packedPredict(compiled,{resource:old,data:next});
    const color = old.currentTurn === 'host' ? 'w' : 'b';
    const enemy = color === 'w' ? 'b' : 'w';
    const {from,to} = next.lastMove;
    const kingMove = old.board[from] === color+'k';
    const location = kingMove ? squares.indexOf(to) : compiled.locateKing(next.board,color+'k');
    const index = typeof location === 'bigint' ? Number(location) : location;
    if (!Number.isInteger(index) || index < -1 || index > 63) throw Error('locateKing must return a square index or -1');
    if (index === -1) return false;
    function safe(square, board) {
      const value = variant === 'optimized' ? compiled['safe'+square](board,enemy,Object.values(board)) : compiled['safe'+square](board,enemy);
      if (typeof value !== 'boolean') throw Error('square safety must return a boolean');
      return value;
    }
    if (!safe(squares[index],next.board)) return false;
    const castle = kingMove && Math.abs(squares.indexOf(from) - index) === 2;
    if (!['castle','optimized'].includes(variant) || !castle) return true;
    const transit = (to[0]==='g' ? 'f' : 'd') + from[1];
    return safe(from,old.board) && safe(transit,old.board);
  }
  return {modules,predict};
}

export async function link(modules,resolveModules,{variant='castle'}={}) {
  const {json,verifyInputs} = await import('../../../arcade/corpus.mjs');
  verifyInputs();
  const app=json('v1/imports.json');
  const key='../games/chess/chess-helpers';
  app.modules['../games/tictactoe/tictactoe']=read('../../sokoban-repair/v1/tictactoe.stock.rules');
  delete app.modules['../games/tictactoe/move-counter'];
  app.modules['../games/chess/chess']=read('../../chess/bundle/artifacts/stronger-module.rules');
  app.modules[key]=read('../../chess/bundle/artifacts/stronger-helpers.rules');
  function bundle() {
    const result=resolveModules(app.root,{modules:app.modules,sourceFile:'firestore.modules.rules'});
    assert.ok(result.success,result.error?.message);
    return result.data.resolved;
  }
  assert.equal(bundle(),read('../../chess/bundle/artifacts/stronger.rules'));
  const names = [...Object.keys(sourcesFor(variant)), 'horizontalPathClear'];
  assert.deepEqual(Object.keys(modules).sort(), names.sort());
  const imports = names.map(name=>{
    app.modules['../games/chess/safety-'+name]=modules[name];
    return "import { "+name+" } from './safety-"+name+"';";
  });
  const header="rules_version = '2+modules';";
  const packed=variant.startsWith('packed');
  const compact=['packed-v2','packed-v3','packed-v4','packed-v5'].includes(variant);
  const optimized=variant==='optimized'||packed;
  if (optimized) {
    app.modules[key] = optimizeValidation(app.modules[key]);
    if (compact) app.modules[key]=compactValidation(app.modules[key]);
    const chess='../games/chess/chess';
    app.modules[chess] = optimizeApplication(app.modules[chess]);
    if (['packed-v3','packed-v4','packed-v5'].includes(variant)) {
      app.modules[chess]=compactAdmission(app.modules[chess]);
      app.modules[key]=once(app.modules[key],'next.board.keys().hasAll(old.board.keys())\n    && pieceShape','pieceShape');
    }
  }
  const call=selectSquare(0,63,s=>'safe'+s+'(board, enemy'+(optimized?', material':'')+')');
  const dispatch='function kingSafeAt(board, enemy, index) { '+(optimized?'let material = board.values(); ':'')+'return index >= 0 && index < 64 && '+call+'; }';
  const castle=['castle','optimized'].includes(variant) ? " && (!castle || (kingSafeAt(old.board, enemy, color == 'w' ? 4 : 60) && kingSafeAt(old.board, enemy, (color == 'w' ? 0 : 56) + (xTo > 4 ? 5 : 3))))" : '';
  const guard=`function safeTransition(old, next, color, kingMove, castle, xTo, yTo) {
    let enemy = color == 'w' ? 'b' : 'w';
    let square = kingMove ? yTo * 8 + xTo : locateKing(next.board, color + 'k');
    return kingSafeAt(next.board, enemy, square)${castle};
  }`;
  const end="&& next.enPassant == nextEp(kind, color == 'w', dy, mv.from[0:1]);";
  const path="pathClear(old.board, x, y, dx, dy)";
  function once(rules,a,b) {
    assert.equal(rules.split(a).length,2,a);
    return rules.replace(a,b);
  }
  let helpers=once(app.modules[key],header,[header,...imports,...(packed?[packedGuard(compact)]:[dispatch,guard])].join('\n'));
  helpers=once(helpers,end,end.slice(0,-1)+" && safeTransition(old, next, color, kind == 'k', castle, x + dx, y + dy);");
  helpers=once(helpers,path,compact?compactPath:"(kind == 'r' && dx != 0 ? horizontalPathClear(old.board, mv.from[1:2], x, x + dx) : "+path+")");
  if (['packed-v4','packed-v5'].includes(variant)) {
    const preserved = "(old.castling == '' ? next.castling == '' : next.castling == keptRights(old.castling, piece, mv.from, mv.to))";
    const corners = "['a1','a8','h1','h8']";
    helpers=once(helpers,preserved,"(old.castling == '' || (kind != 'k' && !(mv.from in "+corners+") && !(mv.to in "+corners+") && old.castling.matches('K?Q?k?q?')) ? next.castling == old.castling : next.castling == keptRights(old.castling, piece, mv.from, mv.to))");
    helpers=once(helpers,compactPath,"(kind == 'p' ? old.board[mv.from[0:1] + (color == 'w' ? '3' : '6')] == '' : "+compactPath+")");
  }
  if (variant==='packed-v5') {
    helpers=helpers+'\n'+dropRights;
    helpers=compactRights(helpers,once);
    helpers=once(helpers,'diagonalPathClear(old.board, x, y, x + dx, y + dy)',linePath);
  }
  app.modules[key]=helpers;
  // Source maps are tool metadata. Keep only the full executable Rules when measuring target size.
  const source=bundle();
  assert.ok(source.trimEnd().split('\n').at(-1).startsWith('// @pyric-source-map: '));
  return source.slice(0,source.lastIndexOf('// @pyric-source-map: '));
}
