import {compile} from './terminal/v1/policy.mjs';
import {loadPolicyApi} from '../king-safety/policy/public-api.mjs';
const [mode,variant,dir,...args]=process.argv.slice(2);
const {compileFunction}=await loadPolicyApi(dir);
const candidate=await compile(compileFunction,variant,{mode});
if (mode==='emit') {
  console.log(JSON.stringify(candidate.modules));
} else if (mode==='standalone') {
  const inputs=JSON.parse(Buffer.from(args.join(''),'base64').toString());
  const predictions=[];
  for (const [i,input] of inputs.entries()) {
    try {
      const value=await candidate.predict(input);
      if (typeof value!=='boolean') throw Error('expected a boolean safety verdict');
      predictions.push({i,decision:value?'ALLOW':'DENY'});
    } catch (error) {
      predictions.push({i,error:String(error?.message??error)});
    }
  }
  console.log(JSON.stringify(predictions));
} else throw Error('unknown consumer task');
