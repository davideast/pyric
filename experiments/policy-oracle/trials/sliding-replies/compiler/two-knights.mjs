import assert from 'node:assert/strict';

// The packed board contains comma-terminated pieces and rank sentinels.
// Require exactly two defending knights and no other defending non-king.
function material(side, enemy) {
  const rest = '(?:[,#]|' + enemy + '[prnbqk],|' + side + 'k,)*';
  return rest + side + 'n,' + rest + side + 'n,' + rest;
}

export const twoKnightSources = {
  onlyTwoKnights: `function onlyTwoKnights(text, whiteMoved) {
    return whiteMoved ? text.matches('${material('b','w')}') : text.matches('${material('w','b')}');
  }`,
};

export function linkTwoKnights(source) {
  const previous = 'otherDefenders(text, white) || hasKingReply(text, defender)';
  assert.equal(source.split(previous).length, 2);
  const knightReply = 'white ? knightPairsb(knightRowsb0(text)) : knightPairsw(knightRowsw0(text))';
  return source.replace(previous, () =>
    '(otherDefenders(text, white) && (!onlyTwoKnights(text, white) || (' + knightReply + '))) || hasKingReply(text, defender)');
}
