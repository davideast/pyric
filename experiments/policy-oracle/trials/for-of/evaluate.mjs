import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {linkCandidate} from './link.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [installed, resolver, output] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
const publicEntry = pkg.exports['./experimental/policy'].import;
const {compileFunction, compileBoundedModule} = await import(pathToFileURL(resolve(installed, publicEntry)));
const {resolveModules} = await import(pathToFileURL(resolve(resolver)));
const fixtures = JSON.parse(readFileSync(join(here, 'reference/cases.json')));
const source = name => readFileSync(join(here, 'policies', name + '.policy'), 'utf8');
const rookSource = source('rook');
const tallySource = source('tally');
const guardSource = source('guard');
const rook = compileFunction(rookSource);
const tally = compileFunction(tallySource, {expressionLimit: 32768});
const guard = compileFunction(guardSource);
const chess = join(here, '../chess/policies');
for (const name of ['chess', 'chess-match']) {
  const old = readFileSync(join(chess, name + '.policy'), 'utf8');
  assert.equal(compileBoundedModule(old).moduleSource, readFileSync(join(chess, name + '.mjs'), 'utf8'));
}

function result(id, call) {
  try {
    const value = call();
    return {id, value: typeof value === 'bigint' ? Number(value) : value};
  } catch (e) {
    const diagnostic = e.message;
    let error;
    if (diagnostic.includes('cannot prove for...of bound')) {
      error = 'unproved';
    } else if (/input length \d+ exceeds declared bound \d+/.test(diagnostic)) {
      error = 'bound';
    } else if (/undefined|missing|no such|not found|does not exist|not present/i.test(diagnostic)) {
      error = 'expression';
    } else {
      throw e;
    }
    return {id, error, diagnostic};
  }
}

function scoreRooks(candidate) {
  return fixtures.rook.map(({id, from, to, occupied}) => {
    const files = 'abcdefgh';
    const board = Object.fromEntries([...files].flatMap(f => [...'12345678'].map(r => [f+r, ''])));
    Object.assign(board, occupied);
    const x = files.indexOf(from[0]), y = Number(from[1]) - 1;
    const before = structuredClone(board);
    const observed = result(id, () => candidate(board, x, y, files.indexOf(to[0]) - x, Number(to[1]) - 1 - y));
    assert.deepEqual(board, before, id + ': policy changed the supplied board');
    return observed;
  });
}
function scoreTurns(candidate) {
  return fixtures.tally.map(({id, start, repeat = 1, moves}) => {
    const turn = Array.from({length: repeat}, () => moves).flat();
    const before = structuredClone(turn);
    const observed = result(id, () => candidate(start, turn));
    assert.deepEqual(turn, before, id + ': policy changed the supplied actions');
    return observed;
  });
}
function target(name, candidate) {
  try {
    const emitted = candidate.firestoreModule();
    writeFileSync(join(output, name + '-module.rules'), emitted);
    return {emitted: true};
  } catch (e) {
    return {emitted: false, diagnostic: e.message};
  }
}

const unbounded = guardSource.replace('bounded(keys, 2)', 'keys');
const shortened = rookSource.replace('[1,2,3,4,5,6]', '[1,2,3,4,5]');
assert.notEqual(guardSource, unbounded);
assert.notEqual(rookSource, shortened);
function diagnostic(expression) {
  try { expression(); }
  catch (e) { return e.message; }
  throw Error('Expected this sample to have a diagnostic');
}
function measureTallyBudget() {
  const strikes = Array.from({length: 400}, () => ({kind: 'strike'}));
  function passes(limit) {
    try {
      const compute = compileFunction(tallySource, {expressionLimit: limit});
      const actual = compute(0, strikes);
      assert.ok(actual === 90 || actual === 90n, 'expected the numeric tally 90');
      return true;
    } catch (e) {
      if (!/expression units/.test(e.message)) throw e;
      return false;
    }
  }
  let exhausted = 0, firstPassing = 32768;
  assert.ok(passes(firstPassing));
  while (firstPassing - exhausted > 1) {
    const limit = Math.floor((firstPassing + exhausted) / 2);
    if (passes(limit)) firstPassing = limit;
    else exhausted = limit;
  }
  return {case: '400-strikes', exhausted, firstPassing};
}
const report = {
  rook: scoreRooks(rook),
  tally: scoreTurns(tally),
  proposed: fixtures.proposed.map(({id, board, keys}) => result(id, () =>
    id === 'unproved-source' ? compileFunction(unbounded).firestoreModule() : guard(board, keys))),
  mutants: {
    'ignore-sixth-square': scoreRooks(compileFunction(shortened)),
    'reverse-actions': scoreTurns((start, actions) => tally(start, actions.toReversed())),
  },
  targets: {tally: target('tally', tally), guard: target('guard', guard)},
  unsupported: {
    withoutOptIn: diagnostic(() => compileFunction(rookSource.replace('use extension loops;', ''))),
    computedElementsOnFirestore: diagnostic(() => compileFunction(
      guardSource.replace('bounded(keys, 2)', "['a', keys[0]]")).firestoreModule()),
    configuredSourceBudget: diagnostic(() => compileFunction(
      source('first-hit'), {expressionLimit: 1}).firestoreModule()),
    nonListInput: diagnostic(() => guard({a: true}, 'ab')),
  },
  standaloneBudget: measureTallyBudget(),
  linked: linkCandidate(compileFunction, resolveModules, output),
};
writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
