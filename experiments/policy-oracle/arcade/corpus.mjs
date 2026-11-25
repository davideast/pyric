import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('./', import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const read = file => readFileSync(root + file, 'utf8');
export const json = file => JSON.parse(read(file));
export const manifestDigest = '6f1a1d54e86d67d6848bee3389c84a5d34cfd2ee367cb21dd209dc9f5ecba93a';
export const manifest = json('v1/manifest.json');

export function verifyInputs() {
  assert.equal(sha(read('v1/manifest.json')), manifestDigest, 'case manifest has changed');
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert.equal(sha(readFileSync(root + file)), expected, 'stale input: ' + file);
  }
  const stock = read('v1/rules/stock.rules');
  const marker = 'function _games_tictactoe_tictactoe__moveBasics() {\n    return request.auth != null && isPlaying() && isMyTurn() && turnFlipped() && ';
  const once = marker + 'moveIncremented();';
  assert.equal(stock.split(once).length, 2);
  assert.equal(read('v1/rules/hand2.rules'), stock.replace(once, marker + '(request.resource.data.moveCount == resource.data.moveCount + 2);'));
}
export function materialize(c, identities = { host: 'HOST', guest: 'GUEST' }) {
  const [batch, variant, name] = c.id.split('/');
  const seed = manifest.seeds[batch];
  const before = { ...structuredClone(seed.before), ...identities };
  assert.equal(before.board[seed.move], '');
  const proposal = { ...structuredClone(before), currentTurn: 'guest', lastMove: seed.move, moveCount: c.count };
  proposal.board[seed.move] = 'host';
  return { batch, variant, name, before, proposal };
}
export function versionNs(iso) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(iso);
  assert.ok(match, 'invalid server update time');
  return BigInt(Date.parse(match[1] + 'Z')) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'));
}
