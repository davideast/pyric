import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {sha} from '../../../arcade/corpus.mjs';
import {verifySource} from './fixtures.mjs';

// Static diagnostics only. Each overlay preserves the old body under an unused
// name and substitutes a refusal or the witness search's "no move" sentinel.
const predicates=['chessMove','sliderStatus','orderedSliderTransition','boardTransition','slideKingw','slideKingb'];
const searches=['slideRooks','slideChooser','slideChooseq','slideChooseb','slideTypedw','slideTypedb'];
const [file,expected,disabled,output]=process.argv.slice(2);
const source=readFileSync(file,'utf8');
verifySource(source,expected);
let derived=source;
for(const name of disabled.split(',')) {
  assert.ok(predicates.includes(name)||searches.includes(name));
  const pattern=new RegExp('function '+name+'\\(([^)]*)\\)\\s*\\{','g');
  assert.equal([...derived.matchAll(pattern)].length,1);
  const sentinel=predicates.includes(name)?'false':'-1';
  derived=derived.replace(pattern,(_,args)=>'function '+name+'('+args+') { return '+sentinel+'; }\n  function dormant'+name+'('+args+') {');
}
verifySource(derived,sha(derived));
writeFileSync(output,derived);
console.log(JSON.stringify({base:expected,disabled,derived:sha(derived),bytes:Buffer.byteLength(derived)}));
