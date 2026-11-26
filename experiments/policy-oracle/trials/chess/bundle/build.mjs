import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json, read, sha, verifyInputs } from '../../../arcade/corpus.mjs';

const [consumer, resolver] = process.argv.slice(2);
if (!consumer || !resolver) throw Error('Usage: bun build.mjs <installed rules package> <installed Arcade resolver>');
const pkg = JSON.parse(readFileSync(join(consumer, 'package.json')));
const { compileFunction } = await import(pathToFileURL(resolve(consumer, pkg.exports['./experimental/policy'].import)));
const { resolveModules } = await import(pathToFileURL(resolve(resolver)));
verifyInputs();

const file = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const artifacts = {};
function save(name, data) {
  writeFileSync(new URL('artifacts/' + name, import.meta.url), data);
  artifacts[name] = { sha256: sha(data), bytes: Buffer.byteLength(data) };
}
function replaceOnce(source, text, replacement) {
  assert.equal(source.split(text).length, 2, 'expected one occurrence of ' + text);
  return source.replace(text, () => replacement);
}
function link(src) {
  const result = resolveModules(src.root, { modules: src.modules, sourceFile: 'firestore.modules.rules' });
  assert.ok(result.success, result.error?.message);
  return result.data.resolved;
}

const src = json('v1/imports.json');
src.modules['../games/tictactoe/tictactoe'] = file('../../sokoban-repair/v1/tictactoe.stock.rules');
delete src.modules['../games/tictactoe/move-counter'];
const stock = link(src);
assert.equal(stock, read('v1/rules/stock.rules'));
save('stock.rules', stock);

const header = "rules_version = '2+modules';\n\n";
const compile = name => {
  const result = compileFunction(file('source/' + name + '.rules')).firestoreModule();
  assert.ok(result.startsWith(header + 'export function ' + name + '('));
  return result.slice(header.length);
};
const chess = '../games/chess/chess';
const helpers = '../games/chess/chess-helpers';
const privateHelper = /function chessCastleSquares\([\s\S]*?\n\}/g;
assert.equal([...src.modules[chess].matchAll(privateHelper)].length, 1);
const compatNames = ['castleMetadata', 'priorPosition'];
const compatHelpers = header + compatNames.map(compile).join('\n');
src.modules[helpers] = compatHelpers;
save('compatibility-helpers.rules', compatHelpers);
let game = src.modules[chess].replace(privateHelper, '// Castling metadata is derived by the imported policy helper.');
game = replaceOnce(game, header, header + "import { castleMetadata, priorPosition } from './chess-helpers';\n");
game = replaceOnce(game, 'chessCastleSquares(piece, color, mv.from, mv.to, request.resource.data.lastMove.extra)',
  'castleMetadata(piece, color, mv.from, mv.to, request.resource.data.lastMove.extra)');
game = replaceOnce(game, ['request.resource.data.prevBoard == resource.data.board',
  'request.resource.data.prevCastling == resource.data.castling',
  'request.resource.data.prevEnPassant == resource.data.enPassant'].join('\n    && '),
  'priorPosition(resource.data, request.resource.data)');
src.modules[chess] = game;
save('compatibility-module.rules', game);
save('compatibility.rules', link(src));

const strongerNames = ['pieceShape', 'coordinate', 'keptRights', 'nextEp', 'rayEmpty', 'castleBoard', 'specialSquares'];
// Only source expressions accepted by the packed pure-function compiler contribute to these exports.
// pathClear and boardTransition are standard Rules glue that calls multiple emitted functions.
const strongerHelpers = compatHelpers + '\n' + strongerNames.map(compile).join('\n')
  + '\n' + file('source/path.rules') + '\nexport ' + file('source/strong.rules');
src.modules[helpers] = strongerHelpers;
save('stronger-helpers.rules', strongerHelpers);
const compatExtra = game.slice(game.indexOf('    && (request.resource.data.lastMove.extra.size()'), game.indexOf('    && request.resource.data.board.keys()'));
assert.ok(compatExtra.includes('castleMetadata(') && compatExtra.includes('resource.data.enPassant'));
const strong = replaceOnce(replaceOnce(replaceOnce(game, compatExtra, ''), '{ castleMetadata, priorPosition }',
  '{ castleMetadata, priorPosition, boardTransition }'),
  'return request.auth != null && isPlaying()', 'return request.auth != null && boardTransition(resource.data, request.resource.data, mv, piece, color) && isPlaying()');
src.modules[chess] = strong;
save('stronger-module.rules', strong);
save('stronger.rules', link(src));

// A server transaction derives the whole next position. No client grant for a move remains.
const moveGrant = "      allow update: if resource.data.status == 'playing' && request.resource.data.status in ['playing', 'won', 'draw'] && (chessMove());\n";
src.modules[chess] = game;
src.modules[helpers] = compatHelpers;
src.root = replaceOnce(src.root, moveGrant, '');
src.root = replaceOnce(src.root, 'chessCreate, chessJoin, chessCancel, chessMove, chessResign',
  'chessCreate, chessJoin, chessCancel, chessResign');
save('referee.rules', link(src));
writeFileSync(new URL('artifacts/manifest.json', import.meta.url), JSON.stringify({ artifacts, compiled: [...compatNames, ...strongerNames] }, null, 2) + '\n');
