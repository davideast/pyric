import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replay } from '../../../../../../../../../adapters/arcade-sdk/v1/replay.mjs';

const root = process.env.ORACLE_ROOT
  ? pathToFileURL(resolve(process.env.ORACLE_ROOT) + sep)
  : new URL('../../../../../../../../../', import.meta.url);
const mutation = {
  from: ' && file(captured) * 2 == file(from) + file(to) && rank(captured) * 2 == rank(from) + rank(to);',
  to: ' && rank(captured) * 2 == rank(from) + rank(to);',
};
console.log(JSON.stringify(await replay(root, new URL('./', import.meta.url), mutation)));
