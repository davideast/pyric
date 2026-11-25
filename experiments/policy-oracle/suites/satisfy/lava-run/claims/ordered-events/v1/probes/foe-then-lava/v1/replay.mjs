import { replay } from '../../../replay-step.mjs';

console.log(JSON.stringify(await replay(new URL('./', import.meta.url))));
