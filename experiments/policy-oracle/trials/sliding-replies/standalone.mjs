import {readFileSync} from 'node:fs';
import {loadPolicyApi} from '../king-safety/policy/public-api.mjs';

const [installed, ...encoded] = process.argv.slice(2);
const {compileBoundedModule} = await loadPolicyApi(installed);
const read = filename => readFileSync(new URL(filename, import.meta.url), 'utf8');
const source = read('../chess/policies/chess.policy') + '\n' + read('sliding-replies.policy');
const {moduleSource} = compileBoundedModule(source);
const policy = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const positions = JSON.parse(Buffer.from(encoded.join(''), 'base64').toString());
const results = positions.map(position => {
  try {
    return {sliding: policy.slidingReplies(position), all: policy.legalMoves(position), outcome: policy.outcome(position)};
  } catch (error) {
    return {error: String(error.message ?? error)};
  }
});
console.log(JSON.stringify(results));
