import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {json, sha, verifyInputs} from '../../../arcade/corpus.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const chess = '../../chess/bundle/';
const checkedStock = read(chess + 'artifacts/stronger.rules');
const source = read('./file-safe.policy');
const pathSource = read('./horizontal-path.policy');

export async function emit(pkgDir, {variant = 'v2'} = {}) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json')));
  const api = await import(pathToFileURL(resolve(pkgDir, pkg.exports['./experimental/policy'].import)));
  const fileSafety = api.compileFunction(source).firestoreModule();
  if (variant === 'v1') return {fileSafety};
  assert.equal(variant, 'v2');
  return {fileSafety, horizontalPath:api.compileFunction(pathSource).firestoreModule()};
}

export function link(modules, resolveModules, {beforeBoard = false, variant = 'v2'} = {}) {
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
  assert.ok(variant === 'v1' || variant === 'v2');
  assert.deepEqual(Object.keys(modules).sort(),variant === 'v1' ? ['fileSafety'] : ['fileSafety','horizontalPath']);
  const header = "rules_version = '2+modules';";
  const last = "&& next.enPassant == nextEp(kind, color == 'w', dy, mv.from[0:1]);";
  const rules = app.modules[helpers];
  assert.equal(rules.split(header).length, 2);
  assert.equal(rules.split(last).length, 2);
  app.modules['../games/chess/file-safety'] = modules.fileSafety;
  const board = beforeBoard ? 'old.board' : 'next.board';
  app.modules[helpers] = rules.replace(header, header + "\nimport { fileSafe } from './file-safety';")
    .replace(last, last.slice(0,-1) + "\n    && (kind != 'r' || dx == 0 || fileSafe(" + board + ", mv.from[0:1], color));");
  if (variant === 'v2') {
    app.modules['../games/chess/horizontal-path'] = modules.horizontalPath;
    const pathCheck = 'pathClear(old.board, x, y, dx, dy)';
    assert.equal(app.modules[helpers].split(pathCheck).length,2);
    app.modules[helpers] = app.modules[helpers].replace(header, header + "\nimport { horizontalPathClear } from './horizontal-path';")
      .replace(pathCheck, "(kind == 'r' && dx != 0 ? horizontalPathClear(old.board, mv.from[1:2], x, x + dx) : " + pathCheck + ')');
  }
  return complete();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pkg, resolver, out, ...flags] = process.argv.slice(2);
  assert.ok(pkg && resolver && out && flags.every(f => ['--before-board','--v1'].includes(f)),
    'build.mjs INSTALLED_PACKAGE_DIR RESOLVER_PATH OUTPUT_DIR [--before-board] [--v1]');
  const options = {variant:flags.includes('--v1') ? 'v1':'v2', beforeBoard:flags.includes('--before-board')};
  const modules = await emit(pkg, options);
  const {resolveModules} = await import(pathToFileURL(resolve(resolver)));
  const rules = link(modules, resolveModules, options);
  mkdirSync(out, {recursive:true});
  writeFileSync(join(out,'generated.rules'),rules);
  writeFileSync(join(out,'file-safe.rules'),modules.fileSafety);
  if (modules.horizontalPath) writeFileSync(join(out,'horizontal-path.rules'),modules.horizontalPath);
  console.log(JSON.stringify({policy:sha(source),module:sha(modules.fileSafety),
    ...(modules.horizontalPath && {horizontalPathPolicy:sha(pathSource),horizontalPathModule:sha(modules.horizontalPath)}),
    handwritten:sha(checkedStock),generated:sha(rules)},null,2));
}
