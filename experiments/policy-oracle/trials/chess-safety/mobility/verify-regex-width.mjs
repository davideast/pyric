import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const [beforeFile,afterFile]=process.argv.slice(2);
const before=readFileSync(beforeFile,'utf8'),after=readFileSync(afterFile,'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
function literalBounds(text){
  const lengths=[],oversized=[];
  for(let i=0;i<text.length;) {
    if(text.startsWith('//',i)){const end=text.indexOf('\n',i+2);i=end<0?text.length:end+1;continue;}
    if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);assert.ok(end>=0);i=end+2;continue;}
    const quote=text[i++];
    if(quote!=="'"&&quote!=='"')continue;
    const start=i;
    while(i<text.length&&text[i]!==quote){if(text[i]==='\\')i++;i++;}
    assert.ok(i<text.length,'unterminated literal');
    // Source bytes upper-bound the decoded length for the ASCII regexes here.
    const value=text.slice(start,i),length=Buffer.byteLength(value);
    lengths.push(length);
    if(length>4096) {
      const declaration=[...text.slice(0,start).matchAll(/function (\w+)\(/g)].at(-1);
      oversized.push({function:declaration[1],sourceBytes:length,contentSha256:sha(value)});
    }
    i++;
  }
  return {literals:lengths.length,maxSourceBytes:Math.max(...lengths),over4096:oversized};
}
function patterns(rules){
  return Object.fromEntries([...rules.matchAll(/  function (allRefused[wb][0-9]+)\(records\) \{\s*return records\.matches\('([^'\n]*)'\);\s*\}/g)]
    .map(([,name,pattern])=>[name,pattern]));
}
function bodyExceptDirections(rules) {
  return rules.replace(/^  function (?:allRefused[wb][0-9]+|hasKingReply)\([^\n]+\) \{\n[\s\S]*?^  \}\n/gm,'');
}
const b=patterns(before),a=patterns(after);
assert.equal(Object.keys(b).length,4);assert.equal(Object.keys(a).length,8);
for(const color of ['w','b'])for(const oldIndex of [0,1]) {
  assert.equal(b['allRefused'+color+oldIndex],a['allRefused'+color+2*oldIndex]+a['allRefused'+color+(2*oldIndex+1)]);
}
assert.equal(bodyExceptDirections(before),bodyExceptDirections(after));
const retained=sha(bodyExceptDirections(after));
const prior=literalBounds(before),fixed=literalBounds(after);
const legacy='_games_reversi_reversi__reversiRays';
assert.deepEqual(fixed.over4096.map(x=>[x.function,x.sourceBytes]),[[legacy,5615]]);
assert.deepEqual(prior.over4096.filter(x=>x.function===legacy),fixed.over4096);
assert.deepEqual(prior.over4096.filter(x=>x.function!==legacy).map(x=>x.sourceBytes).sort((a,b)=>a-b),[7093,7163,7379,7477]);
assert.equal(after.split(legacy+'()').length,3);
assert.ok(after.includes(legacy+"().split(' ')"));
console.log(JSON.stringify({before:sha(before),after:sha(after),allOtherRulesBytesSha256:retained,
  beforeBounds:prior,afterBounds:fixed,regexLengths:Object.fromEntries(Object.entries(a).map(([k,r])=>[k,r.length]))},null,2));
