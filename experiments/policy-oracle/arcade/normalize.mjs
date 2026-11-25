import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {importReceipt} from './receipts.mjs';
const [batch, path] = process.argv.slice(2);
assert.ok(['four','zero'].includes(batch) && path, 'usage: node normalize.mjs zero|four raw-receipt.json');
console.log(JSON.stringify(importReceipt(batch,readFileSync(path)), null, 2));
