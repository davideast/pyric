import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const [installed, corpus] = process.argv.slice(2);
assert.ok(installed && corpus, 'usage: bun sealed.mjs INSTALLED_RULES PRIVATE_CORPUS');
const reference = fileURLToPath(new URL('../for-of/reference/', import.meta.url));
const pins = JSON.parse(readFileSync(resolve(reference, 'author-trial/scores.json'))).reviewed.scores;
const commitment = JSON.parse(readFileSync(resolve(reference, 'holdout-lock.json')));
const results = {};
for (const revision of ['first', 'locked']) {
  const source = resolve(reference, 'author-trial/loop/' + revision + '.policy');
  const digest = pins['loop/' + revision].sourceSha256;
  const raw = execFileSync(process.execPath, [resolve(reference, 'author-score.mjs'), resolve(corpus),
    source, digest, resolve(installed), 'function'], {encoding: 'utf8'});
  const score = JSON.parse(raw);
  assert.equal(score.sourceSha256, digest);
  assert.equal(score.corpusSha256, commitment.sha256);
  assert.equal(score.cases, commitment.cases);
  assert.equal(score.matches, score.cases);
  assert.equal(score.compileError, null);
  assert.equal(score.firstDivergence, null);
  for (const key of ['falseAllows', 'falseRefusals', 'unsupported']) assert.equal(score[key], 0);
  results[revision] = score;
}
console.log(JSON.stringify({commitment, results}, null, 2));
