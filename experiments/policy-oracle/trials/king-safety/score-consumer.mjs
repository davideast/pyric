import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [mode, pkgDir, ...encoded] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(pkgDir,'package.json'),'utf8'));
const entry = pkg.exports['./experimental/policy'].import;
const {compileFunction} = await import(pathToFileURL(resolve(pkgDir,entry)));
const source = readFileSync(new URL('policy/file-safe.policy',import.meta.url),'utf8');
const invoke = compileFunction(source);
if (mode === 'emit') {
  const fileSafety = invoke.firestoreModule();
  if (typeof fileSafety !== 'string') throw Error('compiler returned a non-string module');
  console.log(JSON.stringify({fileSafety}));
} else if (mode === 'standalone') {
  const inputs = JSON.parse(Buffer.from(encoded.join(''),'base64').toString());
  const rows = inputs.map(({id,args}) => {
    try {
      const answer = invoke(...args);
      if (typeof answer !== 'boolean') throw Error('policy returned a non-boolean verdict');
      return {id,decision:answer ? 'ALLOW':'DENY'};
    } catch (err) { return {id,error:String(err?.message ?? err)}; }
  });
  console.log(JSON.stringify(rows));
} else {
  throw Error('unknown compilation mode');
}
