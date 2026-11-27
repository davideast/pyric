import {crossBinding,crossSources} from './cross.mjs';
import {extendedBinding,extendedSources} from './family.mjs';
// In a compact post-move board each playable square occupies one character.
// Two walls between ranks make offsets 1, 9, 10 and 11 the four slider lines.
const directions = {orthogonal: [1, 10], diagonal: [9, 11]};
export const gap = n => n === 0 ? '' : n === 1 ? '[^;]' : '[^;]{' + n + '}';
const alternate = options => '(?:' + options.join('|') + ')';

// An enemy attacks K on a ray exactly when all intervening ray cells are empty.
// Other cells between adjacent ray steps belong to different files or ranks.
export function attacks(color) {
  const tests = [];
  function both(piece, between) {
    tests.push('K' + between + piece, piece + between + 'K');
  }
  for (const [family, strides] of Object.entries(directions)) {
    const pieces = family === 'orthogonal' ? '[rq]' : '[bq]';
    for (const stride of strides) {
      const between = gap(stride - 1);
      both(pieces, between + '(?:,' + between + ')*');
    }
  }
  for (const stride of [8, 12, 19, 21]) both('n', gap(stride - 1));
  for (const stride of [1, 9, 10, 11]) both('k', gap(stride - 1));
  for (const stride of [9, 11]) {
    const between = gap(stride - 1);
    tests.push(color === 'w' ? 'K' + between + 'p' : 'p' + between + 'K');
  }
  return alternate(tests);
}

function projection(stride, length, sign) {
  const skip = gap(stride - 1);
  // Only empty ray cells can occur in the interior. The target can be empty
  // or an opponent other than its king. An off-board step crosses a wall.
  const between = skip + (length > 1 ? '(?:,' + skip + '){' + (length - 1) + '}' : '');
  const captured = '(' + between + ')';
  const target = '[,prnbq]';
  const pattern = sign > 0 ? 'S' + captured + target : target + captured + 'S';
  const next = sign > 0 ? ',$1X' : 'X$1,';
  return "board.replace('" + pattern + "','" + next + "')";
}

export const variants = {'rook-rays-v1':'r', 'rook-cross-v2':'r', 'bishop-cross-v3':'rb', 'queen-cross-v4':'rbq'};

export function sources(variant) {
  const kinds = variants[variant];
  if (!kinds) throw Error('Unknown slider policy variant: ' + variant);
  if (kinds !== 'r') return {...extendedSources(kinds),...crossSources(variant)};
  const out = {};
  for (const color of ['w', 'b']) {
    const enemy = color === 'w' ? 'b' : 'w';
    const other = '(?:[,#]|' + enemy + '[prnbqk],|' + color + 'k,)*';
    const material = other + color + '[' + kinds + '],' + other;
    out['sliderMaterial' + color] =
      "function sliderMaterial" + color + "(text) { return text.matches('" + material + "'); }";
    out['sliderEncode' + color] = "function sliderEncode" + color + "(text) { return text.replace('" +
      color + "k,','K').replace('" + color + "[rbq],','S').replace('" + enemy + "?([prnbqk#]),','$1'); }";
    for (const [family, strides] of Object.entries(directions)) {
      if (family === 'diagonal' && kinds === 'r') continue;
      const moves = [];
      for (const stride of strides) {
        for (const sign of [1, -1]) {
          for (let length = 1; length <= 7; length++) moves.push(projection(stride,length,sign));
        }
      }
      // A failed projection retains S. A successful projection contains X at
      // its landing square. Discard attacked successor boards as whole records.
      const rejected = '[^;]*' + alternate(['S', attacks(color)]) + '[^;]*;';
      const name = 'slider' + family + color;
      out[name] = `function ${name}(board) {
  let boards = [${moves.join(',\n    ')}].join(';') + ';';
  let first = boards.replace('${rejected}', '').split(';')[0];
  return first == '' ? -1 : board.replace('S.*','').size() * 80 + first.replace('X.*','').size();
}`;
    }
  }
  if (variant !== 'rook-rays-v1') {
    for (const key of Object.keys(out)) if (key.startsWith('sliderorthogonal') || key.startsWith('sliderdiagonal')) delete out[key];
    Object.assign(out,crossSources(variant));
  }
  return out;
}

export function binding(variant) {
  if (variants[variant]?.length > 1) return extendedBinding(variants[variant]);
  if (variant !== 'rook-rays-v1') return crossBinding(variant);
  return `function sliderMove(text, defender) {
    return defender == 'w' ? sliderorthogonalw(sliderEncodew(text)) : sliderorthogonalb(sliderEncodeb(text));
  }
  function sliderStatus(text, defender, status) {
    return status == 'playing' ? (hasKingReply(text,defender) || sliderMove(text,defender) >= 0)
      : packedSafe(text,defender) == (status == 'draw') && !hasKingReply(text,defender) && sliderMove(text,defender) < 0;
  }`;
}
