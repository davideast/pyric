import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {json, sha, verifyInputs} from '../../../arcade/corpus.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const chess = '../../chess/bundle/';
const checkedStock = read(chess + 'artifacts/stronger.rules');
const source = read('./file-safe.policy');

export async function emit(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json')));
  const api = await import(pathToFileURL(resolve(pkgDir, pkg.exports['./experimental/policy'].import)));
  return {fileSafety: api.compileFunction(source).firestoreModule()};
}

export function link(modules, resolveModules, {beforeBoard = false} = {}) {
  verifyInputs();
  const app = json('v1/imports.json');
  app.modules['../games/tictactoe/tictactoe'] = read('../../sokoban-repair/v1/tictactoe.stock.rules');
  delete app.modules['../games/tictactoe/move-counter'];
  app.modules['../games/chess/chess'] = read(chess + 'artifacts/stronger-module.rules');
  const helpers = '../games/chess/chess-helpers';
  app.modules[helpers] = read(chess + 'artifacts/stronger-helpers.rules');
  function complete() {
    const result = resolveModules(app.root, {modules: app.modules, sourceFile:'firestore.modules.rules'});
    assert.ok(result.success, result.error?.message);
    return result.data.resolved;
  }
  assert.equal(complete(), checkedStock, 'handwritten complete input changed');
  assert.equal(Object.keys(modules).join(','), 'fileSafety');
  const header = "rules_version = '2+modules';";
  const last = "&& next.enPassant == nextEp(kind, color == 'w', dy, mv.from[0:1]);";
  const rules = app.modules[helpers];
  assert.equal(rules.split(header).length, 2);
  assert.equal(rules.split(last).length, 2);
  app.modules['../games/chess/file-safety'] = modules.fileSafety;
  const board = beforeBoard ? 'old.board' : 'next.board';
  app.modules[helpers] = rules.replace(header, header + "\nimport { fileSafe } from './file-safety';")
    .replace(last, last.slice(0,-1) + "\n    && (kind != 'r' || dx == 0 || fileSafe(" + board + ", mv.from[0:1], color));");
  return complete();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pkg, resolver, out, flag] = process.argv.slice(2);
  assert.ok(pkg && resolver && out && (flag === undefined || flag === '--before-board'),
    'build.mjs INSTALLED_PACKAGE_DIR RESOLVER_PATH OUTPUT_DIR [--before-board]');
  const modules = await emit(pkg);
  const {resolveModules} = await import(pathToFileURL(resolve(resolver)));
  const rules = link(modules, resolveModules, {beforeBoard: flag === '--before-board'});
  mkdirSync(out, {recursive:true});
  writeFileSync(join(out,'generated.rules'),rules);
  writeFileSync(join(out,'file-safe.rules'),modules.fileSafety);
  console.log(JSON.stringify({policy:sha(source),module:sha(modules.fileSafety),handwritten:sha(checkedStock),generated:sha(rules)},null,2));
}
