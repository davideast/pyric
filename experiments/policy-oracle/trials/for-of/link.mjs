import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {json, sha, verifyInputs} from '../../arcade/corpus.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const chess = join(here, '../chess/bundle');
const read = (directory, file) => readFileSync(join(directory, file), 'utf8');

// Resolve the unchanged game modules twice. Any difference in the control
// bytes means the comparison has moved away from the qualified Arcade build.
export function linkCandidate(compileFunction, resolveModules, output) {
  verifyInputs();
  const source = json('v1/imports.json');
  source.modules['../games/tictactoe/tictactoe'] = read(here, '../sokoban-repair/v1/tictactoe.stock.rules');
  delete source.modules['../games/tictactoe/move-counter'];
  source.modules['../games/chess/chess'] = read(chess, 'artifacts/stronger-module.rules');
  const helperPath = '../games/chess/chess-helpers';
  source.modules[helperPath] = read(chess, 'artifacts/stronger-helpers.rules');
  function resolveComplete() {
    const result = resolveModules(source.root, {modules: source.modules, sourceFile: 'firestore.modules.rules'});
    assert.ok(result.success, result.error?.message);
    return result.data.resolved;
  }
  const control = resolveComplete();
  assert.equal(control, read(chess, 'artifacts/stronger.rules'), 'handwritten linked bundle changed');
  const old = read(chess, 'source/path.rules').trimEnd();
  const helper = source.modules[helperPath];
  assert.equal(helper.split(old).length, 2, 'expected a single handwritten function');
  const loop = read(here, 'policies/rook.policy');
  const moduleText = compileFunction(loop).firestoreModule();
  const header = /^rules_version\s*=\s*'2\+modules';\s*export\s+(?=function pathClear\()/;
  assert.match(moduleText, header);
  // Retain the original private visibility within the qualified module.
  source.modules[helperPath] = helper.replace(old, () => moduleText.replace(header, '').trimEnd());
  const linked = resolveComplete();
  writeFileSync(join(output, 'path-module.rules'), moduleText);
  writeFileSync(join(output, 'generated.rules'), linked);
  const witness = compileFunction(read(here, 'policies/first-hit.policy')).firestoreModule();
  source.modules['../loop-evidence'] = witness;
  const wildcard = '    match /{document=**} {';
  assert.equal(source.root.split(wildcard).length, 2);
  source.root = source.root.replace("rules_version = '2+modules';",
    "rules_version = '2+modules';\nimport { firstHit } from '../loop-evidence';");
  source.root = source.root.replace(wildcard, [
    '    match /loopEvidence/{id} {',
    '      allow read: if request.auth != null;',
    '      allow update: if request.auth != null && request.auth.uid == resource.data.owner',
    "        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['checked'])",
    '        && request.resource.data.checked == true && firstHit(resource.data.cells);',
    '    }', wildcard,
  ].join('\n'));
  const errorProof = resolveComplete();
  writeFileSync(join(output, 'first-hit-module.rules'), witness);
  writeFileSync(join(output, 'ordered-errors.rules'), errorProof);
  return {policy: sha(loop), module: sha(moduleText), handwritten: sha(control), generated: sha(linked),
    orderedErrors: sha(errorProof)};
}
