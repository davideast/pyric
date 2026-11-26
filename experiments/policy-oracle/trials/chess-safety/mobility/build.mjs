import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {sha} from '../../../arcade/corpus.mjs';

const [pkg,bundler,out,variant='king-reply']=process.argv.slice(2);
const {compile,link}=await import(variant.startsWith('knight-') ? './knight.mjs' : variant.startsWith('combined-') ? './combined.mjs' : './adapter.mjs');
const {compileFunction}=await loadPolicyApi(pkg);
const api=compile(compileFunction,variant,{mode:'emit'});
const {resolveModules}=await import(pathToFileURL(resolve(bundler)));
const source=await link(api.modules,resolveModules,{variant});
mkdirSync(out,{recursive:true});
writeFileSync(join(out,'complete.rules'),source);
writeFileSync(join(out,'modules.json'),JSON.stringify(api.modules));
console.log(JSON.stringify({rulesSha256:sha(source),sourceBytes:Buffer.byteLength(source),modules:Object.keys(api.modules).length}));
