import assert from 'node:assert/strict';
import * as terminal from '../terminal/table-v2/policy.mjs';
import {compileMobility,linkOnto} from './adapter.mjs';
import {groupedSources} from './grouped.mjs';
import {threeSources,compileThree,wholeBinding} from './three-piece.mjs';
import {bareBinding,compileBare} from './bare.mjs';
import {replySource} from '../terminal/v1/reply.mjs';

const variants=new Set(['combined-bare-packed-v5','combined-whole-packed-v5','combined-whole-fast-packed-v5','combined-whole-lazy-packed-v5','combined-quick-packed-v5','combined-pattern-packed-v5','combined-pattern-fast-packed-v5']);

const backend=variant=>variant.slice(9).replace('pattern-fast-','pattern-').replace(/^whole-(?:(?:fast|lazy)-)?/,'').replace('bare-','');

export function compile(compileFunction,variant,options={mode:'both'}) {
  if (!variants.has(variant)) return terminal.compile(compileFunction,variant,options);
  const base=terminal.compile(compileFunction,backend(variant),options);
  const mobility=compileMobility(compileFunction,{...options,specialized:true,grouped:true});
  const out={...base,modules:{...base.modules,...mobility.modules},hasKingReply:mobility.hasReply,inCheck:mobility.inCheck};
  if(variant.startsWith('combined-whole-')) {
    const three=compileThree(compileFunction,options);
    Object.assign(out.modules,three.modules);
    const reply=compileFunction(replySource());
    if(options.mode!=='standalone')out.modules.replyCapture=reply.firestoreModule();
    out.threePieceStatus=three.threePieceStatus;
  }
  if(variant==='combined-bare-packed-v5') {
    const reply=compileFunction(replySource());
    if(options.mode!=='standalone')out.modules.replyCapture=reply.firestoreModule();
    out.bareDefenderStatus=compileBare(compileFunction,mobility);
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

export async function link(modules,resolveModules,{variant}) {
  if (!variants.has(variant)) return terminal.link(modules,resolveModules,{variant});
  const whole=variant.startsWith('combined-whole-');
  const bare=variant==='combined-bare-packed-v5';
  const extra=whole?[...Object.keys(threeSources()),'replyCapture']:bare?['replyCapture']:[];
  const names=new Set([...Object.keys(groupedSources()),...extra]);
  const group=Object.fromEntries(Object.entries(modules).filter(([key])=>names.has(key)));
  const original=Object.fromEntries(Object.entries(modules).filter(([key])=>!names.has(key)));
  let source=await terminal.link(original,resolveModules,{variant:backend(variant)});
  const lazy=variant==='combined-whole-lazy-packed-v5';
  if(lazy||bare)source=trimMoveWork(source);
  const fast=variant==='combined-pattern-fast-packed-v5';
  if(fast) {
    const old="let stripped = text.split('#|[wb][qrnb]|k').join('');";
    const swap="stripped.split('w').join('X').split('b').join('w').split('X').join('b')";
    assert.equal(source.split(old).length,2);
    assert.equal(source.split(swap).length,2);
    source=source.replace(old,"let stripped = text.replace('#|[wb][qrnb]|k','');")
      .replace(swap,()=>"stripped.replace('([wb])(,*)([wb])','$3$2$1')");
  }
  return linkOnto(source,group,resolveModules,{specialized:true,grouped:true,
    extra,fuseTerminal:bare ? bareBinding : whole ? source=>wholeBinding(source,lazy||variant.includes('whole-fast-')) : source=>fuseTerminal(source,fast)});

}
