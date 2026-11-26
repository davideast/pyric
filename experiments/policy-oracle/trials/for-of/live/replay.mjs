import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {manifest,sha} from '../../../arcade/corpus.mjs';
import {privateArchive} from '../../../arcade/live/controller/archive.mjs';
import {qualify,checkRows,comparable} from './evidence.mjs';
import * as defaults from './fixtures.mjs';

const roles={host:'host',guest:'guest',observer:'observer'};
export async function replay({generated,simulator,archive,ordered}, fixtures = defaults, receipts = new URL('receipts/',import.meta.url)) {
  const {checkBundle,profile} = fixtures;
  const dist = resolve(simulator,'dist/index.js');
  const {firestoreRules} = await import(pathToFileURL(dist));
  const handwritten = fileURLToPath(new URL('../../chess/bundle/artifacts/stronger.rules',import.meta.url));
  const reports=[], operands=[];
  const bundles=[['handwritten',handwritten],['generated',generated]];
  if(ordered) bundles.push(['ordered-errors',ordered]);
  for(const [mode,bundle] of bundles) {
    const ev = JSON.parse(gunzipSync(readFileSync(new URL(mode+'.json.gz',receipts))));
    const source = readFileSync(bundle,'utf8');
    checkBundle(mode,source,ev.rulesSha256);
    assert.equal(ev.mode,mode);
    assert.equal(ev.targetDatabaseUid,manifest.target.uid);
    assert.equal(ev.restored,manifest.target.closedRuleset);
    assert.deepEqual(ev.phases.map(p=>[p.phase,p.rulesSha256]),[
      ['initially-closed',manifest.files['v1/rules/closed.rules']], ['open',sha(source)],
      ['restored-closed',manifest.files['v1/rules/closed.rules']],
    ]);
    assert.deepEqual([ev.closure.leaseReleased,ev.closure.signedRead,ev.closure.signedWrite],[true,'DENY','DENY']);
    if(archive) assert.deepEqual(ev,qualify(privateArchive(archive),ev.privateReceipt,bundle,fixtures));
    const spec = profile(mode);
    checkRows(ev.rows,roles,id=>spec.collection+'/match-'+id,mode,fixtures);
    if(mode!=='ordered-errors') {
      const rows=comparable(ev);
      operands.push(spec.measureAdmission ? rows.map(({after,observed,...submitted})=>submitted) : rows);
    }
    const handle=firestoreRules(source), decisions=[];
    function check(description,method,path,auth,resource,data,expectation) {
      const [r]=handle.simulate([{description,path,method,auth,resource,data,expectation}]).cases;
      assert.ok(!r.unsupported && !r.resourceLimit,description+' unsupported');
      assert.equal(r.decision,expectation,description);
      return r.evaluatedExpressions;
    }
    assert.equal(ev.signedOutRead,'DENY');
    check('signed-out','get','chess/match',null,undefined,undefined,ev.signedOutRead);
    for(const r of ev.rows) {
      const [before]=r.before, [after]=r.after, [op]=r.submitted;
      check(r.id+' before signed read','get',before.path,{uid:r.reader},before.data,undefined,'ALLOW');
      const localExpected = spec.measureAdmission ? spec.cases.find(c=>c.id===r.id).expected : r.observed;
      const cost = check(r.id,'update',op.path,{uid:r.actor},before.data,{...before.data,...op.data},localExpected);
      check(r.id+' after signed read','get',after.path,{uid:r.reader},after.data,undefined,'ALLOW');
      decisions.push({id:r.id,decision:r.observed,versionChanged:after.version !== before.version,localExpressions:cost,
        ...(spec.measureAdmission && {native:localExpected,localVerdict:localExpected})});
    }
    reports.push({mode,bundleSha256:ev.rulesSha256,privateReceipt:ev.privateReceipt,decisions,reads:2*ev.rows.length+1});
  }
  assert.deepEqual(operands[0],operands[1],'paired releases must have identical normalized comparison inputs');
  return {paired:operands[0].length,releases:reports,privateJournalChecked:Boolean(archive)};
}

if(import.meta.main) {
  const [generated,simulator,archiveArg,ordered]=process.argv.slice(2);
  const archive=archiveArg==='-'?undefined:archiveArg;
  if(!generated || !simulator) throw Error('Usage: bun live/replay.mjs GENERATED_COMPLETE_RULES INSTALLED_PINNED_RULES [ARCHIVE [ORDERED_ERRORS_COMPLETE_RULES]]');
  console.log(JSON.stringify(await replay({generated,simulator,archive,ordered}),null,2));
}
