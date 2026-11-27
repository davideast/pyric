import {readFileSync} from 'node:fs';
const read = path=>readFileSync(new URL(path,import.meta.url),'utf8');
export const cases = JSON.parse(read('cases.json'));
export function moves(c) {
  return c.strengths.map((strength,i)=>({kind:'strike',at:i/10,strength}));
}
export function compile(compileFunction) {
  const validStrikes = compileFunction(read('valid-strikes.policy'));
  const tally = compileFunction(read('../../tally-fold/v1/tally.policy'));
  return {validStrikes,tally};
}
export function bundle({validStrikes,tally}) {
  const body = (name,f) => {
    const source = f.firestoreModule(), prefix = "rules_version = '2+modules';\n\nexport ";
    if (!source.startsWith(prefix+'function '+name+'(')) throw Error('expected module export '+name);
    return source.slice(prefix.length).trimEnd();
  };
  return read('binding.rules').replace('/* compiled helpers */',()=>[body('validStrikes',validStrikes),body('tally',tally)].join('\n'));
}
