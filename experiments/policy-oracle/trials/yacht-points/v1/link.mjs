// The pinned resolver links only the candidate's module text into the reviewed match rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function linkModule(arcade, module) {
  const { resolveModules } = await import(pathToFileURL(join(arcade, 'runtime/node_modules/arcade-bundler/dist/rules/modules/resolver.js')));
  const src = JSON.parse(readFileSync(join(arcade, 'v1/imports.json')));
  src.modules['../games/tictactoe/tictactoe'] = readFileSync(new URL('../../sokoban-repair/v1/tictactoe.stock.rules', import.meta.url), 'utf8');
  delete src.modules['../games/tictactoe/move-counter'];
  const bundle = () => {
    const result = resolveModules(src.root, { modules: src.modules, sourceFile: 'firestore.modules.rules' });
    assert.ok(result.success, result.error?.message);
    return result.data.resolved;
  };
  assert.equal(bundle(), readFileSync(join(arcade, 'v1/rules/stock.rules'), 'utf8'));
  const key = '../games/yacht/yacht';
  const source = src.modules[key];
  const start = source.indexOf('function yachtCount(');
  const end = source.indexOf('// Every seat', start);
  const oldCall = 'let pts = yachtPoints(cat, before.dice);';
  assert.ok(start >= 0 && end > start);
  assert.equal(source.split(oldCall).length, 2);
  src.modules[key] = (source.slice(0, start) + source.slice(end))
    .replace("import { isSeatTurn, turnAdvanced }", "import { scoreRoll } from './points';\nimport { isSeatTurn, turnAdvanced }")
    .replace(oldCall, 'let pts = scoreRoll(cat, before.dice);');
  src.modules['../games/yacht/points'] = module;
  return bundle();
}
