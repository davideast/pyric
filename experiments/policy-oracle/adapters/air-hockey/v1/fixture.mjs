import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
export const stock = read('stock.json');
export function generated(compileFunction) {
  const predicate = compileFunction(read('frame.policy')).rtdbNumericPredicate({
    last: {snapshot:'data', path:'puck'}, next: {snapshot:'newData', path:'puck'},
    oldScore: {snapshot:'data', parent:true, path:'score'}, score: {snapshot:'newData', parent:true, path:'score'},
  });
  const rules = JSON.parse(stock);
  const frame = rules.rules.airhockey.$matchId.$host.frame;
  frame['.validate'] = '(' + frame['.validate'] + ') && (!data.exists() || (' + predicate + '))';
  return JSON.stringify(rules, null, 2) + '\n';
}
export const fixtures = JSON.parse(read('frames.json'));
export const seed = (fixture, guest) => ({
  meta:{guest,status:'playing',winner:''}, presence:{host:true, guest:true}, ...fixture.before,
});
