import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const adapter = pathToFileURL(join(process.env.ORACLE_ROOT,'adapters/tally-fold/v1/score.mjs'));
const {standalone} = await import(adapter);
console.log(JSON.stringify(await standalone()));
