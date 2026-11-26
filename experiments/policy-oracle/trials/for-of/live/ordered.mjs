import assert from 'node:assert/strict';
import {sha} from '../../../arcade/corpus.mjs';

const witness = "  function firstHit(cells) {\n    return cells['a'] ? true : cells['b'] ? true : false;\n  }\n";
const binding = [
  '    match /loopEvidence/{id} {',
  '      allow read: if request.auth != null;',
  "      allow update: if request.auth != null && request.auth.uid == resource.data.owner && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['checked']) && request.resource.data.checked == true && firstHit(resource.data.cells);",
  '    }','',
].join('\n');

// The qualified base without its final generated source-map comment.
const baseCodeSha256='7554753754548a19c71066f09e6aacc3562691053b5a1a485e774d68bc2ccf4f';
export function checkOrderedBundle(code) {
  assert.equal(code.split(witness).length,2,'one exact emitted firstHit helper');
  assert.equal(code.split(binding).length,2,'one auxiliary authenticated path');
  assert.equal(sha(code.replace(witness,'').replace(binding,'')),baseCodeSha256,'all other executable rules match the qualified generated Arcade release');
}

export const ordered = {
  collection:'loopEvidence',
  cases:[
    {id:'return-before-missing',cells:{a:true},expected:'ALLOW'},
    {id:'reach-missing',cells:{a:false},expected:'DENY'},
    {id:'missing-before-return',cells:{b:true},expected:'DENY'},
    {id:'return-at-second',cells:{a:false,b:true},expected:'ALLOW'},
  ],
  probe:c=>({cells:c.cells}),
  sample(c,owner) {
    const before={owner,cells:c.cells,checked:false},proposal={checked:true};
    return {before,proposal,after:c.expected==='ALLOW'?{...before,...proposal}:before};
  },
};
