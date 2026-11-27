import assert from 'node:assert/strict';
import {attacks} from './sources.mjs';

function material(side, enemy) {
  const rest = '(?:[,#]|' + enemy + '[prnbqk],|' + side + 'k,)*';
  return rest + side + 'p,' + rest;
}

export const lonePawnSources = {
  onlyLonePawn: `function onlyLonePawn(text, whiteMoved) {
    return whiteMoved ? text.matches('${material('b','w')}') : text.matches('${material('w','b')}');
  }`,
};

for (const side of ['w', 'b']) {
  // The compact board has ten cells per rank, starting at a1. En passant
  // vacates the origin and the captured pawn's square before testing king safety.
  const rankStart = side === 'w' ? 40 : 30;
  const rank = side === 'w' ? 6 : 3;
  const offset = [...'abcdefg'].map((file,i) => `ep=='${file}${rank}' ? '${rankStart+i}' : `).join('') + `'${rankStart+7}'`;
  const projection = side === 'w' ? "replace('T(.{9}),', ',$1X')" : "replace(',(.{9})T', 'X$1,')";
  lonePawnSources['loneEp'+side] = `function loneEp${side}(board, ep) {
    let offset = ${offset};
    let marked = board.replace('^(.{' + offset + '})p', '$1E');
    let cleared = marked.replace('PE', ',T').replace('EP', 'T,');
    let moved = cleared.${projection};
    return ep.matches('[a-h]${rank}') && !moved.matches('.*[PET].*') && !moved.matches('.*${attacks(side)}.*');
  }`;
}

export function linkLonePawn(source) {
  // Use the shared mobility solver. slideTyped returns absence when there is no
  // slider, while slidePawn already projects captures, single and double pushes.
  const guard = '(white ? sliderMaterialb(text) : sliderMaterialw(text)) ? sliderStatus';
  const decision = 'slideMayClaim(status,direction) && slideClaim(status,';
  assert.equal(source.split(guard).length, 2);
  assert.equal(source.split(decision).length, 2);
  // Inlining these two short predicates leaves expression budget for the extra
  // reply. Read the bodies from the emitted modules so the candidate owns them.
  function predicate(name, bindings) {
    const declaration = source.match(new RegExp('function ' + name + '\\(([^)]*)\\) \\{\\s*return ([^;]+);\\s*\\}'));
    assert.ok(declaration,name);
    const params = declaration[1].split(',').map(s=>s.trim());
    const names = new RegExp('\\b(' + params.join('|') + ')\\b','g');
    return '(' + declaration[2].replace(names, p => bindings[params.indexOf(p)]) + ')';
  }
  const may = predicate('slideMayClaim',['status','direction']);
  const claim = predicate('slideClaim',['status','MOBILITY']);
  const first = '(white ? slideKingw(board) : slideKingb(board))';
  const start = source.indexOf(decision) + decision.length;
  const mobility = source.slice(start, source.indexOf(';',start)).trim();
  assert.ok(mobility.startsWith(first) && mobility.endsWith(')'));
  const ep = "(board.matches('.*P.*') && request.resource.data.enPassant!='' && (white ? loneEpw(board,request.resource.data.enPassant) : loneEpb(board,request.resource.data.enPassant)))";
  const original = decision+'\n      '+mobility;
  assert.equal(source.split(original).length,2);
  const reply = '('+ep+' || '+mobility.slice(0,-1)+')';
  const sharedStatus = may+' && '+claim.replace('MOBILITY', () => reply);
  const materialGuard = '((white ? sliderMaterialb(text) : sliderMaterialw(text)) || onlyLonePawn(text,white)) ? sliderStatus';
  return source.replace(guard, () => materialGuard).replace(original, () => sharedStatus);
}
