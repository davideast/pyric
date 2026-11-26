import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {replay}=await import(pathToFileURL(join(process.env.ORACLE_ROOT,'trials/chess-safety/registry/evaluate.mjs')));
console.log(JSON.stringify(await replay(new URL('.',import.meta.url))));
