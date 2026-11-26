import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {argumentsFor} from './reference/native.mjs';

const [installed, mode] = process.argv.slice(2);
assert.ok(installed && [undefined, '--baseline'].includes(mode),
  'usage: bun score.mjs INSTALLED_RULES [--baseline]');
const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
const entry = resolve(installed, manifest.exports['./experimental/policy'].import);
const {compileFunction} = await import(pathToFileURL(entry).href);
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const sha = source => createHash('sha256').update(source).digest('hex');
const cases = json('./reference/cases.json');
const nativeChess = json('./reference/native.json').results;
const revisions = json('../for-of/reference/author-trial/scores.json').reviewed.scores;
const authors = {};
for (const revision of ['first', 'locked']) {
  const source = read('../for-of/reference/author-trial/loop/' + revision + '.policy');
  assert.equal(sha(source), revisions['loop/' + revision].sourceSha256);
  authors[revision] = source;
}

function observe(run) {
  try {
    let value = run();
    if (typeof value === 'bigint') {
      const integer = Number(value);
      assert.equal(BigInt(integer), value);
      value = integer;
    }
    return {value};
  } catch (error) {
    return {error: error.name, message: error.message};
  }
}

function invokeReadOnly(invoke, args, id) {
  const before = structuredClone(args);
  const result = observe(() => invoke(...args));
  assert.deepEqual(args, before, id + ': policy mutated inputs');
  return result;
}

function chessRows(source) {
  const invoke = compileFunction(source);
  assert.deepEqual(cases.rook.map(c => c.id), nativeChess.map(c => c.id));
  return cases.rook.map((c, i) => {
    const native = nativeChess[i];
    assert.equal(native.nativeLegal, native.handwrittenPathClear, c.id);
    assert.equal(native.nativeLegal, c.expected === 'ALLOW', c.id);
    return {id: c.id, expected: {value: native.nativeLegal},
      observed: invokeReadOnly(invoke, argumentsFor(c), c.id)};
  });
}

const missing = {error: 'EvalError', message: 'Property missing is undefined on object.'};
function languageRows(source) {
  const invoke = compileFunction(source);
  return cases.language.map(c => {
    const expected = c.error === 'missing' ? missing : {value: c.standalone};
    return {id: c.id, expected, observed: invokeReadOnly(invoke, [c.cells], c.id)};
  });
}

function checkMatches(rows) {
  for (const row of rows) assert.deepEqual(row.observed, row.expected, row.id);
  return rows;
}

function sensitivity(rows, witness, expected, observed) {
  const changed = rows.filter(row => !isDeepStrictEqual(row.expected, row.observed));
  assert.ok(changed.length > 0, 'mutation undetected');
  assert.deepEqual(changed[0], {id: witness.id, expected, observed}, 'first wrong verdict');
  return {firstDivergence: changed[0], changedCases: changed.map(row => row.id), cases: rows.length};
}

function tallyRows() {
  const invoke = compileFunction(read('../for-of/policies/tally.policy'), {expressionLimit: 32768});
  const turns = json('../for-of/reference/cases.json').tally;
  const model = json('../for-of/reference/native.json').tally;
  assert.deepEqual(turns.map(c => c.id), model.map(c => c.id));
  return turns.map((c, i) => {
    const moves = Array.from({length: c.repeat ?? 1}, () => c.moves).flat();
    const native = model[i];
    const observed = invokeReadOnly(invoke, [c.start, moves], c.id);
    assert.equal(moves.length, native.actions, c.id);
    const expected = c.expected.error === 'bound'
      ? {error: 'ResourceLimitError', message: 'tally: for...of input length 401 exceeds declared bound 400'}
      : {value: native.singleMoveModel};
    assert.deepEqual(observed, expected, c.id);
    return {id: c.id, nativeModel: native.singleMoveModel, turnParserAccepted: native.turnParser.accepted, observed};
  });
}

function boundCheck(source) {
  const dynamic = source.replace('firstHit(cells)', 'firstHit(cells, keys)')
    .replace("['missing']", 'bounded(keys, 1)');
  assert.notEqual(dynamic, source);
  const invoke = compileFunction(dynamic);
  function run(length) {
    const reads = [];
    const keys = Array(length);
    for (let index = 0; index < length; index++) {
      Object.defineProperty(keys, index, {get() { reads.push(index); return 'missing'; }});
    }
    const observed = observe(() => invoke({stop: true}, keys));
    return {reads, observed};
  }
  const tooLong = run(2), allowed = run(1);
  assert.deepEqual(tooLong, {reads: [], observed: {error: 'ResourceLimitError',
    message: 'firstHit: for...of input length 2 exceeds declared bound 1'}});
  assert.deepEqual(allowed, {reads: [0], observed: {value: true}});
  return {tooLong, allowed};
}

const rewrite = checkMatches(chessRows(authors.locked));
const tally = tallyRows();
if (mode === '--baseline') {
  const parse = observe(() => compileFunction(authors.first));
  assert.equal(parse.message, revisions['loop/first'].compileError);
  assert.ok(parse.error, 'expected the old parser to reject the second if');
  console.log(JSON.stringify({first: parse, rewrite, tally}, null, 2));
} else {
  const original = checkMatches(chessRows(authors.first));
  const guard = read('./policies/first-hit.policy');
  const language = checkMatches(languageRows(guard));

  const lines = authors.first.split('\n');
  const first = lines.findIndex(line => line.trimStart().startsWith('if '));
  assert.ok(first >= 0 && lines[first + 1].trimStart().startsWith('if '));
  [lines[first], lines[first + 1]] = [lines[first + 1], lines[first]];
  const reverse = cases.mutationWitnesses.reverseGuards;
  const reverseGuards = sensitivity(chessRows(lines.join('\n')), reverse,
    {value: reverse.was}, {value: reverse.becomes});

  // Constructing this pair evaluates both guards before selecting the first.
  // The returned booleans keep their original priority on fully defined inputs.
  const eagerSource = guard.replace('if (cells.stop)', 'if ([cells.stop, cells[key]][0])');
  assert.notEqual(eagerSource, guard);
  const eager = cases.mutationWitnesses.eagerSecond;
  assert.equal(eager.becomes, 'missing');
  const eagerSecond = sensitivity(languageRows(eagerSource), eager, {value: eager.was}, missing);
  assert.deepEqual(eagerSecond.changedCases, [eager.id], 'defined guard priorities changed');
  console.log(JSON.stringify({original, rewrite, language, tally,
    checkedBound: boundCheck(guard), mutations: {reverseGuards, eagerSecond}}, null, 2));
}
