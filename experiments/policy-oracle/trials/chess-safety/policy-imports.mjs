import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {relative,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Inspect only trusted source imports before opening a candidate tarball. The
// candidate receives these implementation files and explicitly named input DSL.
const trial=fileURLToPath(new URL('.',import.meta.url));
const modules=new Set(), parser=new Bun.Transpiler({loader:'js'});
function visit(file){
  const name=relative(trial,file);
  assert.equal(realpathSync(file),file);
  assert.ok(/^(?:policy|mobility|terminal\/(?:v1|table-v2)|pawns\/v1)\/[a-z0-9-]+\.mjs$/.test(name),'unexpected policy import: '+name);
  if(modules.has(name))return;
  modules.add(name);
  for(const source of parser.scanImports(readFileSync(file,'utf8'))){
    if(source.path.startsWith('node:'))continue;
    if(source.kind==='dynamic-import' && source.path==='../../../arcade/corpus.mjs')continue; // reviewed linker-only input
    assert.equal(source.kind,'import-statement','unexpected dynamic dependency '+source.path);
    assert.ok(source.path.startsWith('.'));
    visit(resolve(dirname(file),source.path));
  }
}
visit(resolve(trial,'mobility/knight.mjs'));
console.log(JSON.stringify([...modules].sort()));
