import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../../arcade/corpus.mjs';
import {profile as primary, checkBundle} from '../fixtures.mjs';

export {checkBundle};
const bytes = readFileSync(new URL('../../reference/cost-position.json',import.meta.url));
assert.equal(sha(bytes),'05000731394a8baa188a865025e8e4d454fa797e3d962ffba77ccd5e842c1226');
export function profile(mode) {
  return {...primary(mode),measureExpressionLimit:true,cases:JSON.parse(bytes)};
}
