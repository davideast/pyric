import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {sourcePath, sourceDigest} from '../../invite-profile/v1/fixture.mjs';

const stock = readFileSync(new URL('../../../' + sourcePath, import.meta.url),'utf8');
assert.equal(sha(stock), sourceDigest);
const ownership = 'get(/databases/$(database)/documents/invites/$(request.resource.data.inviteCode)).data.usedBy == request.auth.uid';
assert.equal(stock.split(ownership).length, 2);
const after = stock.replace(ownership, ownership.replace('get(', 'getAfter('));
assert.equal(sha(after), '0d18f0798dd6e4a7d3600af0216510bb40664199f4fcdc4ba0ad0099dc62751d');
export const sources = {stock, 'get-after':after};
