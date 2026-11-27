// The offline candidate returns module text only. The scorer links it independently.
import {loadPolicyApi} from '../king-safety/policy/public-api.mjs';
import {sources} from './policy-variant.mjs';

const [installed,variant] = process.argv.slice(2);
const {compileFunction} = await loadPolicyApi(installed);
const modules = {};
for (const [name,source] of Object.entries(sources(variant))) {
  modules[name] = compileFunction(source).firestoreModule();
}
console.log(JSON.stringify(modules));
