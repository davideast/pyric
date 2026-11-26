import {readFileSync} from 'node:fs';
import {loadPolicyApi} from './policy/public-api.mjs';

const [mode, pkgDir, variant, ...encoded] = process.argv.slice(2);
const {compileFunction} = await loadPolicyApi(pkgDir);
const source = readFileSync(new URL('policy/file-safe.policy',import.meta.url),'utf8');
const invoke = compileFunction(source);
if (mode === 'emit') {
  const fileSafety = invoke.firestoreModule();
  if (typeof fileSafety !== 'string') throw Error('compiler returned a non-string module');
  const modules = {fileSafety};
  if (variant === 'v2') {
    const pathSource = readFileSync(new URL('policy/horizontal-path.policy',import.meta.url),'utf8');
    modules.horizontalPath = compileFunction(pathSource).firestoreModule();
  }
  console.log(JSON.stringify(modules));
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
