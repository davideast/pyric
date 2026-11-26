import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {qualify} from './evidence.mjs';

const [archive,digest,bundle] = process.argv.slice(2);
const evidence = qualify(privateArchive(archive),digest,bundle);
const bytes = Buffer.from(JSON.stringify(evidence,null,2)+'\n');
const out = new URL('receipts/',import.meta.url);
mkdirSync(out,{recursive:true});
const file = new URL(evidence.mode+'.json.gz',out);
try { writeFileSync(file,gzipSync(bytes,{level:9}),{flag:'wx'}); }
catch(e) { if(e.code!=='EEXIST') throw e; assert.deepEqual(gunzipSync(readFileSync(file)),bytes); }
console.log(evidence.mode,evidence.privateReceipt,evidence.journalSha256,'original deny-all verified, lease released');
