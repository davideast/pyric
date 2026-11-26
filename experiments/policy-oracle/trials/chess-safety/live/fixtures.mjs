import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {basename,join} from 'node:path';
import {sha} from '../../../arcade/corpus.mjs';
import {sample} from '../reference/fixtures.mjs';
import {sampleRights} from '../exploration/rights-claims-v1/fixture.mjs';

const read = url => readFileSync(url,'utf8');
const here = new URL('./',import.meta.url);
const stock = read(new URL('../../chess/bundle/artifacts/stronger.rules',here));
const digest = /^[0-9a-f]{64}$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function reviewedPlan(name) {
  assert.match(name,slug);
  const plan = JSON.parse(read(new URL('plans/'+name+'.json',here)));
  assert.match(plan.rulesSha256,digest);
  const review = JSON.parse(read(new URL('reviews/'+plan.rulesSha256+'.json',here)));
  assert.equal(review.rulesSha256,plan.rulesSha256);
  const bundle = review.file.startsWith('../artefacts/') && process.env.CHESS_SAFETY_ARTEFACTS
    ? join(process.env.CHESS_SAFETY_ARTEFACTS,basename(review.file))
    : fileURLToPath(new URL(review.file,here));
  function checkBundle(mode,source,supplied) {
    assert.equal(mode,name);
    assert.equal(supplied,plan.rulesSha256);
    assert.equal(sha(source),supplied);
    // Every capture uses the reviewed standalone bytes. Match paths and every
    // allow clause stay identical to the handwritten bundle on this target.
    const bindings = s => {
      const lines=s.trimEnd().split('\n');
      if(lines.at(-1).startsWith('// @pyric-source-map: ')) lines.pop();
      const i=lines.findIndex(l=>l.trim()==='match /databases/{database}/documents {');
      assert.ok(i>=0);
      return lines.slice(i).join('\n');
    };
    assert.equal(bindings(source),bindings(stock),'match and allow clauses changed');
  }
  checkBundle(name,readFileSync(bundle,'utf8'),plan.rulesSha256);
  const batches = new Map(), cases = [];
  for (const input of plan.inputs) {
    assert.match(input.sha256,digest);
    const bytes = readFileSync(new URL(input.file,here));
    assert.equal(sha(bytes),input.sha256,'frozen positions changed for '+input.batch);
    assert.ok(input.adapter === undefined || input.adapter === 'successor-rights');
    let selected=JSON.parse(bytes);
    if(input.ids) {
      const byId=new Map(selected.map(c=>[c.id,c]));
      assert.equal(byId.size,selected.length);
      selected=input.ids.map(id=>{assert.ok(byId.has(id),'missing selected case '+id);return byId.get(id);});
    }
    for (const raw of selected) {
      const {id,fen,uci,claim} = raw;
      assert.match(id,/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
      assert.ok(!batches.has(id),'duplicate case '+id);
      batches.set(id,input.batch);
      const c={id,fen,uci,...(claim && {claim})};
      if(input.adapter === 'successor-rights') {
        assert.equal(typeof raw.claimedRights,'string');
        assert.match(raw.claimedRights,/^K?Q?k?q?$/);
        c.claimedRights=raw.claimedRights;
      } else assert.ok(!Object.hasOwn(raw,'claimedRights'));
      cases.push(c);
    }
  }
  assert.ok(cases.length);
  function profile(mode) {
    assert.equal(mode,name);
    return {collection:'chess',measureAdmission:true,cases,
      sample:(c,writer,other)=>Object.hasOwn(c,'claimedRights') ? sampleRights(c,writer,other) : sample(c,writer,other),
      probe:({id,...submitted})=>submitted};
  }
  return {plan,bundle,batches,fixtures:{checkBundle,profile},
    receipts:new URL('receipts/'+plan.rulesSha256+'/',here)};
}
