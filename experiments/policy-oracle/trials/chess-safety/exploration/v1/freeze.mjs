import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sha} from '../../../../arcade/corpus.mjs';
import {freeze} from './corpus.mjs';

const rows=freeze(),text=JSON.stringify(rows),counts={};
for(const r of rows) {
  const v=counts[r.group]??={allow:0,deny:0};
  v[r.nativeAdmission?'allow':'deny']++;
}
const summary={sourceSeed:'0x246ece17',sha256:sha(text),total:rows.length,groups:counts};
const packed=new URL('corpus.json.gz',import.meta.url);
const manifest=new URL('freeze.json',import.meta.url);
if(process.argv[2]==='--freeze') {
  writeFileSync(packed,gzipSync(text,{level:9}),{flag:'wx'});
  writeFileSync(manifest,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
} else {
  assert.deepEqual(JSON.parse(readFileSync(manifest)),summary,'frozen score summary changed');
  assert.equal(gunzipSync(readFileSync(packed)).toString(),text,'frozen native corpus changed');
}
console.log(JSON.stringify(summary,null,2));
