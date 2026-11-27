import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {score} = await import(pathToFileURL(join(process.env.ORACLE_ROOT,'adapters/air-hockey-missing-frame/v1/score.mjs')));
console.log(JSON.stringify(await score()));
