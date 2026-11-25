import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replay } from '../../../../../../../../../adapters/arcade-sdk/v1/replay.mjs';

const root = process.env.ORACLE_ROOT
  ? pathToFileURL(resolve(process.env.ORACLE_ROOT) + sep)
  : new URL('../../../../../../../../../', import.meta.url);
const mutation = {
  from: "direction == 'down' && after < before",
  to: "direction == 'down' && (field == 'pushes' ? after <= before : after < before)",
};
console.log(JSON.stringify(await replay(root, new URL('./', import.meta.url), mutation)));
