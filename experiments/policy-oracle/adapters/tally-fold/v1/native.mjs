import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from '../../../arcade/corpus.mjs';
import {cases,moves} from './fixture.mjs';
const source = new URL('../../../suites/satisfy/tally-slate/claims/ordered-fold/v1/probes/native-turns/v1/fixtures/sources.json',import.meta.url);
const {native} = JSON.parse(readFileSync(source));
const root = resolve(process.argv[2]);
for (const [file,digest] of Object.entries(native.files)) assert.equal(sha(readFileSync(resolve(root,file))),digest,file);
assert.equal(JSON.parse(readFileSync(resolve(root,'node_modules/zod/package.json'))).version,native.parserZod);
const load = file=>import(pathToFileURL(resolve(root,file)).href);
const {createTallySlateModel} = await load(native.path);
const {parseTallyTurn,tallyNext} = await load(native.turnParser);
const rows = {};
for (const c of cases) {
  const input = moves(c), model = createTallySlateModel({value:90});
  for (const move of input) {
    if (move.kind === 'strike') model.strike();
    else if (move.kind === 'erase') model.erase();
    else throw Error('unrecognized native move');
  }
  const parsed = parseTallyTurn({moves:input});
  assert.ok(parsed.ok);
  const total = tallyNext({value:90},parsed.turn.moves).value;
  assert.equal(model.value,total);
  rows[c.id] = {model:model.value, turnParser:{total,accepted:true}, claimMatchesNative:c.claim === total,
    boundedResult:input.length > 2 ? {error:'bound-exceeded'} : {total,accepted:c.claim === total}};
}
console.log(JSON.stringify({revision:native.revision,rows},null,2));
