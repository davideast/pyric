import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha, verifyInputs } from '../../corpus.mjs';
import { readProbe } from '../../../adapters/arcade-sdk/v1/evidence.mjs';

const root = new URL('../../../', import.meta.url);
const read = url => readFileSync(url);
const probes = [
  ['yacht', 'yacht-score', 'five-equal-dice'],
  ['sokoban', 'push-tiebreak', 'equal-moves'],
  ['checkers', 'jump-midpoint', 'single-jump'],
];

export function stockProbes() {
  verifyInputs();
  const baseline = JSON.parse(read(new URL('baselines/follow-on-v1.json', root))).pins;
  return probes.map(([game, claim, probe]) => {
    const base = 'suites/arcade/' + game + '/claims/' + claim + '/v1/';
    const probePath = base + 'probes/' + probe + '/v1/';
    const url = new URL(probePath, root);
    const claimBytes = read(new URL(base + 'claim.json', root));
    const recipeBytes = read(new URL('recipe.json', url));
    assert.equal(sha(claimBytes), baseline[base + 'claim.json']);
    assert.equal(sha(recipeBytes), baseline[probePath + 'recipe.json']);
    for (const [path, digest] of Object.entries(JSON.parse(recipeBytes).pins)) {
      const source = path.startsWith('@oracle/') ? new URL(path.slice(8), root) : new URL(path, url);
      assert.equal(sha(read(source)), digest, path);
    }
    return { game, url, directory: fileURLToPath(url), probe: readProbe(url),
      inputDigest: sha(Buffer.concat([claimBytes, Buffer.alloc(1), recipeBytes])) };
  });
}
