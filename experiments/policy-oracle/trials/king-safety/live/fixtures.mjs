import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {handwritten} from '../../for-of/live/fixtures.mjs';
import {sample} from '../reference/fixtures.mjs';

const read = path => readFileSync(new URL(path,import.meta.url),'utf8');
const frozen = read('../reference/positions.json');
assert.equal(sha(frozen),'e094b8218691bf7efe0070db356ab88bace68680fa23dc06e58cf4607e0f2588');
const inputs = JSON.parse(frozen);
const releases = JSON.parse(read('releases.json'));

export function checkBundle(mode, source, digest) {
  assert.ok(mode==='handwritten' || mode==='generated');
  assert.equal(typeof releases[mode],'string','release requires a reviewed SHA-256 pin');
  assert.equal(digest,releases[mode]);
  assert.equal(sha(source),digest);
  if (mode==='handwritten') {
    assert.equal(source,handwritten);
    return;
  }
  const executable = text => {
    const lines = text.trimEnd().split('\n');
    assert.ok(lines.pop().startsWith('// @pyric-source-map: '));
    return lines.join('\n');
  };
  const code = executable(source);
  const helper = code.match(/^  function fileSafe\(board, file, color\) \{[^{}]*^  \}\n/gm) ?? [];
  assert.equal(helper.length,1);
  assert.equal(sha(helper[0]),releases.linkedHelper);
  const guard = " && (kind != 'r' || dx == 0 || fileSafe(next.board, mv.from[0:1], color))";
  assert.equal(code.split(guard).length,2);
  assert.equal(code.replace(helper[0],'').replace(guard,''),executable(handwritten),
    'only the reviewed pure helper and its restrictive move guard may differ');
}

export function profile(mode) {
  assert.ok(mode==='handwritten' || mode==='generated');
  // The input file intentionally contains no admission verdict. The scorer
  // joins the observed writes to the separate native reference by case ID.
  return {
    collection:'chess', measureAdmission:true, cases:inputs,
    probe:({fen,uci})=>({fen,uci}), sample,
  };
}
