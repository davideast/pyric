import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {replay} = await import(pathToFileURL(join(process.env.ORACLE_ROOT,'adapters/ai-jrpg-campaign/v1/replay.mjs')));
console.log(JSON.stringify(await replay('profile-lifecycle','app')));
