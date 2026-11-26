import assert from 'node:assert/strict';
import * as terminal from '../terminal/table-v2/policy.mjs';
import {compileMobility,linkOnto} from './adapter.mjs';
import {groupedSources} from './grouped.mjs';
import {threeSources,compileThree,wholeBinding} from './three-piece.mjs';
import {directSources,directWrapper,compileDirect,directGroupedSources,directGroupedWrapper} from './direct.mjs';
import {packedSources} from '../policy/packed.mjs';
import {bareBinding,compileBare} from './bare.mjs';
import {lineSources} from './lines.mjs';
import {replySource} from '../terminal/v1/reply.mjs';

// Named experiments remain independently reconstructible. Configure their
// mechanics here so standalone emission and the trusted linker use the same
// reply algorithm, complete-board class and application specialization.
const bare={domain:'bare',base:'packed-v5',lazy:true};
const direct={...bare,reply:'direct'};
const groupedDirect={...bare,reply:'direct-grouped'};
const slim={...groupedDirect,specialize:true};
const whole={domain:'three',base:'packed-v5'};
const pattern={domain:'table',base:'pattern-packed-v5'};
const variants=new Map(Object.entries({
  'combined-quick-packed-v5':{domain:'table',base:'quick-packed-v5'},
  'combined-pattern-packed-v5':pattern,
  'combined-pattern-fast-packed-v5':{...pattern,fast:true},
  'combined-whole-packed-v5':whole,
  'combined-whole-fast-packed-v5':{...whole,fast:true},
  'combined-whole-lazy-packed-v5':{...whole,fast:true,lazy:true},
  'combined-bare-packed-v5':bare,
  'combined-bare-direct-packed-v5':direct,
  'combined-bare-direct-grouped-packed-v5':groupedDirect,
  'combined-bare-slim-packed-v5':slim,
  'combined-bare-simple-packed-v5':{...slim,simple:true},
  'combined-bare-pairs-packed-v5':{...slim,simple:true,width:2},
  'combined-bare-line-packed-v5':{...slim,lines:true},
}));

export function compile(compileFunction,variant,options={mode:'both'}) {
  const config=variants.get(variant);
  if(!config)return terminal.compile(compileFunction,variant,options);
  const base=terminal.compile(compileFunction,config.base,options);
  const {packNormal,packedSafe}=packedSources(true);
  const mobility=config.reply
    ? compileDirect(compileFunction,options,packNormal,packedSafe,config.reply==='direct-grouped',config.width)
    : compileMobility(compileFunction,{...options,specialized:true,grouped:true});
  const out={...base,modules:{...base.modules,...mobility.modules},hasKingReply:mobility.hasReply,inCheck:mobility.inCheck};
  if(config.domain==='three') {
    const three=compileThree(compileFunction,options);
    Object.assign(out.modules,three.modules);
    out.threePieceStatus=three.threePieceStatus;
  }
  if(config.domain==='bare')out.bareDefenderStatus=compileBare(compileFunction,mobility);
  if(config.domain!=='table') {
    const extra={replyCapture:replySource(),...(config.lines?lineSources():{})};
    for(const [name,source] of Object.entries(extra)) {
      const func=compileFunction(source);
      if(options.mode!=='standalone')out.modules[name]=func.firestoreModule();
    }
  }
  return out;
}

// The exact material branch decides all three status values. In other material,
// a correct status needs independent evidence for check and for possible replies.
// Reuse the original class guard and classifier after the Arcade module resolver.
function fuseTerminal(source,fast=false) {
  const start='return packedSafe(text, color) && (';
  const end=") && (next.status == 'playing' || !replyCapture(text, color));";
  assert.ok(source.startsWith(start)&&source.endsWith(end),'unexpected terminal compiler binding');
  const body=source.slice(start.length,-end.length);
  const separator=']) || ';
  assert.equal(body.split(separator).length,2,'expected one three-piece class condition');
  const at=body.indexOf(separator);
  const outside=body.slice(0,at+2);
  let exact=body.slice(at+separator.length);
  if(fast) {
    // Except for queens, each three-piece terminal FEN places the kings at
    // Chebyshev distance two. Distinct padded file/rank offsets cover every
    // such placement; offset collisions only send extra positions to the table.
    const offsets=[2,8,12,18,19,20,21,22];
    const between=offsets.map(n=>'(?:[^,]*,){'+(n-1)+'}').join('|');
    const possible=".*(?:[wb]q,|[wb]k,(?:"+between+")[wb]k,).*";
    exact="(text.matches('"+possible+"') ? "+exact+" : next.status == 'playing')";
  }
  assert.ok(outside.startsWith('castle || !text.matches('));
  assert.ok(outside.includes('|| !(next.board[next.lastMove.to] in ['));
  const general="(next.status == 'playing' || plausibleTerminal(castle ? packNormal(next.board) : text,color,next.status))";
  const test='return packedSafe(text, color) && (('+outside+') ? '+general+' : '+exact+');';
  const helpers=`function plausibleTerminal(text, color, status) {
    let defender = color == 'w' ? 'b' : 'w';
    return packedSafe(text, defender) == (status == 'draw')
        && !replyCapture(text,color) && !hasKingReply(text,defender);
  }`;
  return {test,helpers};
}

// Reuse the original en-passant path only when a pawn actually captures en
// passant. Ordinary moves require the same empty extra-square list directly.
function trimMoveWork(source) {
  function edit(before,after) {
    assert.equal(source.split(before).length,2,'unexpected binding '+before);
    source=source.replace(before,after);
  }
  edit('safeTransition(old, next, color, kingMove, castle, xTo, yTo)',
       'safeTransition(old, next, color, castle, xTo)');
  edit("safeTransition(old, next, color, kind == 'k', castle, x + dx, y + dy)",
       'safeTransition(old, next, color, castle, x + dx)');
  const original="specialSquares(old, next, kind, color, mv.to[0:1], mv.from[1:2], ep)";
  edit(original,'(ep ? '+original+' : mv.extra == [])');
  return source;
}

// nextEp's file slice and color flag are needed only for a double pawn
// advance. During a castle the certified king starts on e1/e8 and arrives at
// c1/c8 or g1/g8; neither endpoint changes the opponent's corner rights.
function specializeMove(source) {
  function edit(before,after) {
    assert.equal(source.split(before).length,2,'unexpected move-specialization anchor '+before);
    source=source.replace(before,after);
  }
  edit("nextEp(kind, color == 'w', dy, mv.from[0:1])",
    "(kind == 'p' && dy == (color == 'w' ? 2 : -2) ? mv.from[0:1] + (color == 'w' ? '3' : '6') : '')");
  const rights='_games_chess_chess_helpers__dropRights(old.castling, piece, mv.from, mv.to)';
  edit(rights,"(castle ? old.castling.replace(color == 'w' ? '[KQ]' : '[kq]', '') : "+rights+")");
  return source;
}

export async function link(modules,resolveModules,{variant}) {
  const config=variants.get(variant);
  if(!config)return terminal.link(modules,resolveModules,{variant});
  const whole=config.domain==='three',bare=config.domain==='bare';
  let customReply=null;
  if(config.reply==='direct')customReply={names:Object.keys(directSources()),wrapper:directWrapper()};
  if(config.reply==='direct-grouped')customReply={names:Object.keys(directGroupedSources(config.width)),wrapper:directGroupedWrapper(config.width)};
  const extra=whole?[...Object.keys(threeSources()),'replyCapture']:bare?['replyCapture']:[];
  if(config.lines)extra.push(...Object.keys(lineSources()));
  const names=new Set([...(customReply?.names??Object.keys(groupedSources())),...extra]);
  const group=Object.fromEntries(Object.entries(modules).filter(([key])=>names.has(key)));
  const original=Object.fromEntries(Object.entries(modules).filter(([key])=>!names.has(key)));
  let source=await terminal.link(original,resolveModules,{variant:config.base});
  if(config.lazy)source=trimMoveWork(source);
  if(config.specialize)source=specializeMove(source);
  if(config.lines) {
    for(const [name,replacement] of [['filePathClear','filedClear'],['horizontalPathClear','rankedClear']]) {
      const call=name+'(old.board,';
      assert.equal(source.split(call).length,2);
      source=source.replace(call,replacement+'(old.board,');
    }
  }
  if(config.domain==='table'&&config.fast) {
    const old="let stripped = text.split('#|[wb][qrnb]|k').join('');";
    const swap="stripped.split('w').join('X').split('b').join('w').split('X').join('b')";
    assert.equal(source.split(old).length,2);
    assert.equal(source.split(swap).length,2);
    source=source.replace(old,"let stripped = text.replace('#|[wb][qrnb]|k','');")
      .replace(swap,()=>"stripped.replace('([wb])(,*)([wb])','$3$2$1')");
  }
  let bind=source=>fuseTerminal(source,config.fast);
  if(whole)bind=source=>wholeBinding(source,config.fast);
  if(bare)bind=source=>bareBinding(source,config.simple);
  return linkOnto(source,group,resolveModules,{specialized:true,grouped:true,extra,customReply,fuseTerminal:bind});
}
