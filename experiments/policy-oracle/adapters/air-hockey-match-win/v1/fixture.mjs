import {readFileSync} from 'node:fs';
import {generated as frameRules} from '../../air-hockey/v1/fixture.mjs';
import {fixtures as missing} from '../../air-hockey-missing-frame/v1/fixture.mjs';

const read = file => readFileSync(new URL(file,import.meta.url),'utf8');
const native = JSON.parse(read('../../air-hockey-winning/v1/frames.json'));
export const fixtures = {'winning-goal':native['winning-goal'], ...missing};

export function generated(compileFunction) {
  const rules = JSON.parse(frameRules(compileFunction));
  const match = rules.rules.airhockey.$matchId.$host;
  const before = {snapshot:'data',path:'score'};
  const after = {snapshot:'newData',path:'score'};
  const wins = compileFunction(read('reaches-seven.policy')).rtdbNumericPredicate({before,after});
  const frame = compileFunction(read('../../air-hockey/v1/frame.policy')).rtdbNumericPredicate({
    last:{snapshot:'data',path:'frame/puck'}, next:{snapshot:'newData',path:'frame/puck'},
    oldScore:before, score:after,
  });
  // Keep the frame's type guards inside the implication. The first metadata
  // write creates a match before either a frame or a score exists.
  const terminalCheck = '!(' + wins + ') || (' + frame + ')';
  match['.validate'] = match['.validate'] === undefined ? terminalCheck :
    '(' + match['.validate'] + ') && (' + terminalCheck + ')';
  return JSON.stringify(rules,null,2)+'\n';
}
