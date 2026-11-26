import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pieces, tile, verdict} from './endings.mjs';
import {touching} from '../v1/geometry.mjs';
import {patternSources} from './patterns.mjs';

const frozen = JSON.parse(readFileSync(new URL('native.json', import.meta.url)));
const hash = createHash('sha256');
const encodeSquare = square => square % 8 + (square >> 3) * 10;
const status = {won: 'checkmate', draw: 'stalemate', playing: 'playing'};
const expectedCounts = {};
// Extract only the fixed patterns from the public policy sources and validate their
// complete language over legal king placements. Rules engine tests are separate.
const compiledPatterns = Object.values(patternSources()).map(source =>
  [...source.matchAll(/\((kings\.matches\('[^']+'\)|false) \? status == 'won' : (kings\.matches\('[^']+'\)|false) \? status == 'draw' : status == 'playing'\)/g)]
    .map(match => match.slice(1).map(test => test === 'false' ? null : new RegExp('^(?:'+test.split("'")[1]+')$'))));
assert.equal(compiledPatterns.length, 64);
assert.ok(compiledPatterns.every(patterns => patterns.length === pieces.length));
let count = 0;
for (const color of ['w','b']) for (const [kind,piece] of pieces.entries()) {
  const counts = expectedCounts[color + piece] = {playing: 0, checkmate: 0, stalemate: 0};
  for (let square = 0; square < 64; square++) {
    const table = tile(piece, square, 1);
    const [won, draw] = compiledPatterns[square][kind];
    for (let defender = 0; defender < 64; defender++) for (let attacker = 0; attacker < 64; attacker++) {
      if (square === defender || square === attacker || touching(attacker, defender)) continue;
      const label = verdict(piece, square, defender, attacker);
      const a = encodeSquare(attacker), d = encodeSquare(defender);
      const offset = d * table.width;
      const row = Number(table.header.slice(offset, offset + table.width));
      assert.equal(table.data[row * 80 + a], label[0]);
      const lo = Math.min(a,d), hi = Math.max(a,d);
      const encoded = ','.repeat(lo) + (a === lo ? 'w' : 'b') + ','.repeat(hi-lo) + (d === hi ? 'b' : 'w') + ','.repeat(80-hi);
      assert.equal(won?.test(encoded) ? 'won' : draw?.test(encoded) ? 'draw' : 'playing', label);
      const result = status[label];
      counts[result]++;
      hash.update([color,piece,square,defender,attacker,result].join(' ')+'\n');
      count++;
    }
  }
}
assert.deepEqual(expectedCounts,frozen.tally);
assert.equal(count, frozen.positions);
assert.equal(hash.digest('hex'), frozen.sha256);
console.log(JSON.stringify({positions: count, nativeSha256: frozen.sha256, tiledAndPatternGeometryAgree: true}));
