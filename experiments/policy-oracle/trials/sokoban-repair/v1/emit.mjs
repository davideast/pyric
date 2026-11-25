// This entry point sees the policy and submitted package. The referee links the output.
import {readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function compileModule(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir,'package.json'),'utf8'));
  const {compilePolicy} = await import(pathToFileURL(resolve(packageDir, manifest.exports['./experimental/policy'].import)));
  const bindings = Object.fromEntries(['before','after'].flatMap(side => ['moves','pushes'].map(field =>
    [side+'.'+field, (side==='before' ? 'resource' : 'request.resource')+'.data.'+field])));
  return compilePolicy(readFileSync(new URL('best-score.policy',import.meta.url),'utf8')).firestoreModule(bindings);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({module:await compileModule(process.argv[2])}));
}
