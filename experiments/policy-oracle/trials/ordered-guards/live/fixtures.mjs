import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {sample as chessSample,checkBundle as checkChessBundle} from '../../for-of/live/fixtures.mjs';

const here = file => readFileSync(new URL(file,import.meta.url),'utf8');
const fixtureBytes = here('../reference/cases.json');
assert.equal(sha(fixtureBytes),'5727eb223d49100e7ce9d1123d222a915611ecb5b0cc0ca7bdda21a1f71c8b7f');
const {rook,language} = JSON.parse(fixtureBytes);
const approved = JSON.parse(here('releases.json'));

export function checkBundle(mode,source,digest) {
  assert.equal(typeof approved[mode], 'string', 'release must be independently pinned before opening');
  assert.equal(digest, approved[mode], 'only the reviewed complete ruleset may be deployed');
  assert.equal(sha(source), digest);
  if (mode === 'handwritten' || mode === 'generated') {
    checkChessBundle(mode,source,digest);
    return;
  }
  assert.equal(mode, 'ordered-errors');
  const code = source.trimEnd().split('\n').slice(0,-1).join('\n');
  const {supplement} = approved;
  for (const fragment of [supplement.helper,supplement.binding]) {
    assert.equal(code.split(fragment).length,2,'exact owner binding and emitted helper must occur once');
  }
  const base = code.replace(supplement.helper,'').replace(supplement.binding,'');
  assert.equal(sha(base),supplement.generatedExecutable,'every other executable byte matches the generated chess release');
}

export function profile(mode) {
  if (mode === 'handwritten' || mode === 'generated') {
    return {cases:rook,collection:'chess',probe:({fen,uci})=>({fen,uci}),sample:chessSample};
  }
  assert.equal(mode,'ordered-errors');
  return {
    cases:language,collection:'loopEvidence',probe:({cells})=>({cells}),
    sample({cells,expected},owner) {
      const before = {owner,cells,checked:false};
      const proposal = {checked:true};
      return {before,proposal,after:expected === 'ALLOW' ? {...before,...proposal} : before};
    },
  };
}
