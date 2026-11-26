import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {comparable} from '../../../for-of/live/evidence.mjs';
import {profile as primary} from '../fixtures.mjs';
import {profile as cost} from '../cost/fixtures.mjs';

export const singleRelease='optimized';
const bytes=readFileSync(new URL('../../reference/path-cost-controls.json',import.meta.url));
assert.equal(sha(bytes),'66c9099711d70a87d78bece84c550b55566976ddd78045d7bd438ecfb8156eb1');
const releases=JSON.parse(readFileSync(new URL('../releases.json',import.meta.url)));

export function profile(mode) {
  assert.equal(mode,singleRelease);
  const p=primary('generated');
  return {...p,measureExpressionLimit:true,cases:[...p.cases,...cost('generated').cases,...JSON.parse(bytes)]};
}

export function checkBundle(mode,source,digest) {
  assert.equal(mode,singleRelease);
  assert.equal(digest,releases.optimized);
  assert.equal(sha(source),digest);
  const lines=source.trimEnd().split('\n');
  assert.ok(lines.pop().startsWith('// @pyric-source-map: '));
  const code=lines.join('\n');
  const helpers=code.match(/^  function horizontalPathClear\(board, rank, x, toX\) \{[^{}]*^  \}\n/gm)??[];
  assert.equal(helpers.length,1);
  assert.equal(sha(helpers[0]),releases.linkedHorizontalPath);
  const oldPath='_games_chess_chess_helpers__pathClear(old.board, x, y, dx, dy)';
  const replacement="(kind == 'r' && dx != 0 ? horizontalPathClear(old.board, mv.from[1:2], x, x + dx) : "+oldPath+')';
  assert.equal(code.split(replacement).length,2);
  assert.equal(sha(code.replace(helpers[0],'').replace(replacement,oldPath)),releases.generatedExecutable);
}

export function compareControlInputs() {
  const inputs=path=>comparable(JSON.parse(gunzipSync(readFileSync(new URL(path,import.meta.url)))))
    .map(({after,observed,...submitted})=>submitted);
  const control=[...inputs('../receipts/handwritten.json.gz'),...inputs('../cost/receipts/handwritten.json.gz')];
  const optimized=inputs('receipts/optimized.json.gz');
  assert.deepEqual(optimized.slice(0,control.length),control);
  assert.deepEqual(optimized.slice(control.length).map(r=>r.id),JSON.parse(bytes).map(c=>c.id));
  return control.length;
}
