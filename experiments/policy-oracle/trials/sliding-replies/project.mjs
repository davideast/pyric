// Encode the submitted post-move position. Chess verdicts are produced by the policy.
import {readFileSync} from 'node:fs';
import {priorPosition} from '../chess/verify/document.mjs';
import {sample} from '../chess-safety/reference/fixtures.mjs';

const [mode] = process.argv.slice(2);
const data = JSON.parse(readFileSync(0, 'utf8'));
if (mode === 'positions') {
  console.log(JSON.stringify(data.map(request => priorPosition(request.data))));
} else if (mode === 'writes') {
  console.log(JSON.stringify(data.map(fixture => {
    const {before,proposal} = sample(fixture, 'host', 'guest');
    return {description:fixture.id, path:'chess/match-'+fixture.id, method:'update', auth:{uid:'host'},
      resource:before, data:{...before,...proposal}, expectation:'ALLOW'};
  })));
} else {
  throw Error('Use writes or positions');
}
