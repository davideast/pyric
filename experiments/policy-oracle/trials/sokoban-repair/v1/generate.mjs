// Compile the scoring order and place it at the stock Arcade update guard.
import assert from 'node:assert/strict';
import { compileModule } from './emit.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageDir, arcadeDir, output, emittedFile] = process.argv.slice(2);
if (!output) throw Error('Usage: bun generate.mjs PACKAGE_DIR ORACLE_ARCADE_DIR OUTPUT');
const read = path => readFileSync(path, 'utf8');
const local = name => read(new URL(name, import.meta.url));
const src = JSON.parse(read(join(arcadeDir, 'v1/imports.json')));

const { resolveModules } = await import(pathToFileURL(resolve(arcadeDir, 'runtime/node_modules/arcade-bundler/dist/rules/modules/resolver.js')));
const bundle = () => {
  const result = resolveModules(src.root, { modules: src.modules, sourceFile: 'firestore.modules.rules' });
  assert.ok(result.success, result.error?.message);
  return result.data.resolved;
};
src.modules['../games/tictactoe/tictactoe'] = local('tictactoe.stock.rules');
delete src.modules['../games/tictactoe/move-counter'];
assert.equal(bundle(), read(join(arcadeDir, 'v1/rules/stock.rules')), 'unmodified Arcade bundle must match its deployed stock bytes');
const module = emittedFile ? read(emittedFile) : await compileModule(packageDir);
const key = '../games/sokoban/sokoban';
function replaceOnce(from, to) {
  assert.equal(src.modules[key].split(from).length, 2);
  src.modules[key] = src.modules[key].replace(from, to);
}
replaceOnce("import { improvedBy } from 'counters';", "import { onlyFieldsChanged } from 'lifecycle';\nimport { betterScore } from './best-score';");
replaceOnce("(improvedBy('moves', 'down', ['pushes', 'solve', 'object', 'createdAt'])\n      || improvedBy('pushes', 'down', ['solve', 'object', 'createdAt']))",
  "onlyFieldsChanged(['moves', 'pushes', 'solve', 'object', 'createdAt'])\n    && betterScore()");
src.modules['../games/sokoban/best-score'] = module;
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'helper.rules'), module);
writeFileSync(join(output, 'full.rules'), bundle());
