import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {position} from '../../chess/reference/score.mjs';
import {squareName} from '../../chess/reference/arcade-reference.ts';
import {sample} from '../../chess-safety/reference/fixtures.mjs';

const [sdk,bundle,option]=process.argv.slice(2);
if (!sdk || !bundle || (option && !['--focused','--roster'].includes(option))) throw Error('Usage: bun witness.mjs PINNED_SDK COMPLETE_RULES [--focused|--roster]');
const {firestoreRules}=await import(pathToFileURL(resolve(sdk,'dist/index.js')));
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
const full=readFileSync(bundle,'utf8');
const anchor='  match /databases/{database}/documents {';
const required=['packNormal','sliderMove','sliderMaterialw','sliderMaterialb'];
const functionNames=new Set([...full.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map(m=>m[1]));
const missing=required.filter(name=>!functionNames.has(name));
if(full.split(anchor).length!==2) missing.push('Firestore document match');
const auditMatch=`
    match /witnessAudit/{id} {
      allow update: if sliderMove(request.resource.data.text,request.resource.data.side) >= -1;
    }
    match /materialAudit/{id} {
      allow update: if request.resource.data.side == 'w' ? sliderMaterialw(request.resource.data.text) : sliderMaterialb(request.resource.data.text);
    }
    match /representationAudit/{id} {
      allow update: if packNormal(request.resource.data.board) == request.resource.data.text;
    }`;
// Only the diagnostic match clauses differ; every helper and original match is
// retained byte for byte. The complete-write runs below use the original source.
const diagnostic=full.replace(anchor,()=>anchor+auditMatch);
const probe=firestoreRules(diagnostic), original=firestoreRules(full);
const errors=r=>r.resourceLimit?'resource-limit':r.unsupported?'unsupported':
  r.trace.some(t=>t.verdict==='ERROR')?'evaluation-error':null;
const expressions=r=>r.trace.flatMap(rule=>rule.expressionTrace??[]);
const calls=(r,name)=>expressions(r).filter(e=>e.kind==='functionCall' && !e.skipped && e.source.startsWith(name+'('));
function dataFor(fen) {
  const pos=position(fen);
  const board=Object.fromEntries(pos.board.map((piece,i)=>[squareName(i),piece]));
  let text='';
  for(let rank=1;rank<=8;rank++){
    for(const file of 'abcdefgh') text+=board[file+rank]+',';
    text+='#,#,';
  }
  return {board,text,side:pos.turn};
}
function square(encoded) {
  if (!Number.isInteger(encoded) || encoded<0 || encoded>77 || encoded%10>7) return null;
  return 'abcdefgh'[encoded%10]+(Math.floor(encoded/10)+1);
}
function decode(index) {
  if (index===-1) return null;
  if (!Number.isInteger(index) || index<0) return 'invalid-encoding';
  const src=square(Math.floor(index/80)), dest=square(index%80);
  return src && dest && src!==dest ? src+dest : 'invalid-encoding';
}
function run(handle,path,data,id) {
  return handle.simulate([{description:id,method:'update',path:path+'/sample',auth:{uid:'writer'},
    resource:{},data,expectation:'ALLOW'}]).cases[0];
}
function inspected(row) {
  const d=dataFor(row.successor);
  const representation=run(probe,'representationAudit',d,row.id);
  const shapeError=errors(representation) ?? (representation.decision==='ALLOW'?null:'pack-mismatch');
  const guarding=run(probe,'materialAudit',d,row.id);
  const guardRows=calls(guarding,'sliderMaterial'+d.side);
  const validGuard=guardRows.length===1 && typeof guardRows[0].value==='boolean';
  const guardErrors=errors(guarding) ?? (validGuard?null:'invalid-guard-value');
  const supported=guardErrors?null:guardRows[0].value;
  const result=run(probe,'witnessAudit',d,row.id);
  const returned=calls(result,'sliderMove');
  const validResult=returned.length===1 && Number.isInteger(returned[0].value);
  const state=errors(result) ?? (validResult?null:'invalid-witness-value');
  const code=state?null:returned[0].value;
  const move=state?null:decode(code);
  const expected=row.sliderReplies;
  const outcome=shapeError??(guardErrors?'guard-error':null)??state??(move===null?(expected.length?'missed-reply':'correct-absence'):
      expected.includes(move)?'legal-witness':'illegal-witness');
  return {id:row.id,supported,code,move,expected,outcome,expressions:result.evaluatedExpressions,
    ...(guardErrors?{guardError:guardErrors}:{})};
}
function routes(handle=original,groups=null) {
  const all=[];
  const cohorts=groups??['rook','bishop','queen'].map(piece=>read('../native/'+piece+'/native.json').cases);
  for(const cases of cohorts){
    for(const row of cases){
      const {before,proposal}=sample(row,'writer','other');
      const req={description:row.id,path:'chess/oracle',method:'update',auth:{uid:'writer'},
        resource:before,data:{...before,...proposal},expectation:'ALLOW'};
      const r=handle.simulate([req]).cases[0];
      const side=row.successor.split(' ')[1];
      const guards=calls(r,'sliderMaterial'+side);
      const wrapper=calls(r,'sliderMove');
      // v3+ reuses a decoded board and check direction. Its status path calls
      // the integer-producing function directly; false status alone is no witness.
      const shared=calls(r,'slideTyped'+side);
      const helper=wrapper.length?wrapper:shared;
      const status=calls(r,'sliderStatus');
      const branch=helper.length?'witness-called':status.length?'slider-status-short-circuit':
        guards.some(g=>g.value===false)?'fallback':guards.some(g=>g.error)?'error-in-guard':'before-slider-dispatch';
      all.push({id:row.id,expected:row.nativeAdmission?'ALLOW':'DENY',local:r.decision,error:errors(r),
        expressions:r.evaluatedExpressions,branch,guard:guards.map(e=>e.value??null),
        actualWitness:helper.map(e=>({callee:e.source.slice(0,e.source.indexOf('(')),
          ...(e.error?{error:e.error}:{code:e.value,move:decode(e.value)})}))});
    }
  }
  return all;
}
function add(counts,key){ counts[key]=(counts[key]??0)+1; }

// The material promises are fixed independently of candidate source. In the
// pawn extension, a defending pawn is supported only without an opposing pawn.
function materialPromises(fen) {
  const [placement,side]=fen.split(' ');
  const own=[],opponent=[];
  for(const piece of placement.match(/[prnbqk]/gi)){
    const white=piece===piece.toUpperCase();
    (white===(side==='w')?own:opponent).push(piece.toLowerCase());
  }
  const material=own.filter(piece=>piece!=='k');
  const sliders=material.filter(piece=>'rbq'.includes(piece));
  const single=sliders.length===1;
  const optionalPawn=material.length===1 || (material.length===2 && material.includes('p') && !opponent.includes('p'));
  const twoDefenders=(single && optionalPawn) ||
    (material.length===2 && (material.every(p=>p==='r') || single && material.includes('n')));
  return {rook:single && material.length===1 && sliders[0]==='r',
    bishop:single && optionalPawn && 'rb'.includes(sliders[0]),
    queen:single && optionalPawn,
    'queen-with-knight-or-rooks':twoDefenders,
    'including-sole-knight':twoDefenders || (material.length===1 && material[0]==='n')};
}

function auditMaterial(rows,scores) {
  const promises={rook:{},bishop:{},queen:{},'queen-with-knight-or-rooks':{},'including-sole-knight':{}};
  const firstMismatch={};
  const qualification=Object.fromEntries(Object.keys(promises).map(profile=>[profile,{
    boards:rows.length,eligible:0,verifiedWitnesses:0,guardDisagreements:0}]));
  for(let i=0;i<rows.length;i++){
    const row=rows[i],score=scores[i];
    for(const [profile,expected] of Object.entries(materialPromises(row.successor))){
      const category=score.supported===null?'guard-error':
        expected?(score.supported?'included':'omitted'):(score.supported?'overincluded':'excluded');
      add(promises[profile],category);
      const q=qualification[profile];
      if(expected){
        q.eligible++;
        if(score.supported===true && ['legal-witness','correct-absence'].includes(score.outcome)) q.verifiedWitnesses++;
      }
      if(!['included','excluded'].includes(category)){
        q.guardDisagreements++;
        (firstMismatch[profile]??={})[category]??={id:row.id,successor:row.successor};
      }
    }
  }
  for(const q of Object.values(qualification)) q.passes=q.guardDisagreements===0 && q.eligible===q.verifiedWitnesses;
  return {promises,firstMismatch,qualification};
}

function auditUsage(focused,traces){
  const byBoard=new Map(focused.map(row=>[row.id,row]));
  const counts={}; const firstFailure={};
  const audited=Object.fromEntries(focused.map(r=>[r.id,{required:2,verified:0,claims:{}}]));
  const names=new Set(traces.flatMap(t=>t.actualWitness.map(w=>w.callee)));
  const forced={};
  for(const [label,code] of [['absent',-1],['present',3432]]){
    let modified=full;
    for(const name of names){
      assert.ok(['sliderMove','slideTypedw','slideTypedb'].includes(name));
      const declaration=new RegExp('\\bfunction\\s+'+name+'\\s*(\\([^)]*\\))\\s*\\{','g');
      const matches=[...modified.matchAll(declaration)];
      if(matches.length!==1) continue;
      modified=modified.replace(declaration,(_signature,params)=>
        'function '+name+params+' { return '+code+'; }\n  function disabled_'+name+params+' {');
    }
    const observations=names.size?routes(firestoreRules(modified)):[];
    forced[label]={sha256:sha(modified),byId:new Map(observations.map(r=>[r.id,r]))};
  }
  for(const trace of traces){
    const suffix=trace.id.slice(trace.id.lastIndexOf('-')+1);
    const row=byBoard.get(trace.id.slice(0,-suffix.length-1));
    assert.ok(row);
    const actual=trace.actualWitness;
    // Every focused successor is in check with either no reply at all or one
    // legal slider reply. A draw claim may be rejected solely from check.
    const needed=suffix!=='draw';
    const valid=v=>Number.isInteger(v.code) && (v.code===-1?row.expected.length===0:row.expected.includes(decode(v.code)));
    let category;
    let diagnostics;
    if(!needed && !actual.length) category='draw-short-circuit';
    else if(!actual.length) category=trace.branch==='fallback'?'fallback':'required-unobserved';
    else if(!actual.every(valid)) category='incorrect-return-on-write';
    else if(needed){
      const absent=forced.absent.byId.get(trace.id),present=forced.present.byId.get(trace.id);
      const verdict=(r)=>r?{decision:r.local,error:r.error}:null;
      diagnostics={absent:verdict(absent),present:verdict(present)};
      if(trace.error || !absent || !present || absent.error || present.error) category='counterfactual-inconclusive';
      else if(trace.local!==trace.expected) category='original-verdict-disagrees';
      else if(absent.local===(suffix==='won'?'ALLOW':'DENY') && present.local===(suffix==='playing'?'ALLOW':'DENY')){
        category='witness-used';
      } else category='sign-dependence-unverified';
    } else category='redundant-draw-witness';
    add(counts,category);
    if(needed && category!=='witness-used') firstFailure[category]??=trace.id;
    audited[row.id].claims[suffix]={category,...(diagnostics?{forced:diagnostics}:{})};
    if(needed && category==='witness-used')audited[row.id].verified++;
  }
  return {counts,firstFailure,byBoard:audited,
    forcedAbsenceRulesSha256:forced.absent.sha256,forcedPresenceRulesSha256:forced.present.sha256};
}
function tally(rows,scores) {
  const result={boards:rows.length,scopes:{},byFamily:{},byDefendingMaterial:{},byFeature:{},
    firstDivergences:{},smallestSupportedDivergences:{},decisionsSha256:sha(JSON.stringify(scores))};
  for(let i=0;i<rows.length;i++){
    const row=rows[i],score=scores[i],scope=score.supported===null?'guard-error':score.supported?'guard-true':'guard-false';
    const status=scope+'/'+score.outcome;
    add(result.scopes[scope]??={},score.outcome);
    add(result.byFamily[row.family]??={},status);
    add(result.byDefendingMaterial[row.defenderMaterial]??={},status);
    for(const f of row.features) add(result.byFeature[f]??={},status);
    if(!['legal-witness','correct-absence'].includes(score.outcome)) {
      const divergence={...score,source:row.fen,uci:row.uci,successor:row.successor,allReplies:row.replies};
      result.firstDivergences[status]??=divergence;
      if(score.supported) {
        const pieceCount=row.successor.split(' ')[0].match(/[a-z]/gi).length;
        const previous=result.smallestSupportedDivergences[status];
        if(!previous || pieceCount<previous.pieceCount) {
          result.smallestSupportedDivergences[status]={pieceCount,...divergence};
        }
      }
    }
  }
  return result;
}
const focused=[];
for(const group of ['rook','bishop','queen']) {
  const rows=read('../native/'+group+'/independent.json').boards;
  for(const r of rows) focused.push({id:r.id,fen:r.source,uci:r.move,successor:r.successor,replies:r.replies,sliderReplies:r.replies});
}
const result={authority:'pinned independent local Rules evaluator on the emitted helper and original write paths',
  rulesSha256:sha(full),diagnosticRulesSha256:sha(diagnostic),interface:{status:missing.length?'missing':'present',missing}};
function rosterControls(){
  const text=readFileSync(new URL('./roster/boards.json',import.meta.url),'utf8').trimEnd();
  const meta=read('./roster/freeze.json');assert.equal(sha(text),meta.inputsAndRepliesSha256);
  const rows=JSON.parse(text),scores=rows.map(inspected);
  const inputs=rows.flatMap(row=>['playing','draw','won'].map(status=>({...row,id:row.id+'-'+status,
    claim:{status,winner:status==='won'?(row.fen.split(' ')[1]==='w'?'host':'guest'):''},nativeAdmission:status===row.status})));
  const writeRoutes=routes(original,[inputs]);
  return {inputsAndRepliesSha256:meta.inputsAndRepliesSha256,scores,materialAudit:auditMaterial(rows,scores),routes:writeRoutes};
}
if(missing.length){
  result.focused=focused.map(row=>({id:row.id,supported:null,code:null,move:null,expected:row.sliderReplies,
    outcome:'missing-witness-interface',expressions:0}));
  result.routes=[];
}else if(option==='--roster'){
  result.rosterControls=rosterControls();
}else{
  result.focused=focused.map(inspected);
  result.routes=routes();
  result.materialAudit={focused:auditMaterial(focused,result.focused)};
  result.fullWriteDerivation=auditUsage(result.focused,result.routes);
  if(option!=='--focused'){
    result.rosterControls=rosterControls();
    for(const [field,directory] of [['panel','panel'],['otherTurns','other-turns']]){
      const bytes=gunzipSync(readFileSync(new URL('./'+directory+'/boards.json.gz',import.meta.url)));
      const meta=read('./'+directory+'/freeze.json');assert.equal(sha(bytes),meta.inputsAndRepliesSha256);
      const rows=JSON.parse(bytes);const scores=rows.map(inspected);
      result[field]={inputsAndRepliesSha256:meta.inputsAndRepliesSha256,...tally(rows,scores)};
      result.materialAudit[field]=auditMaterial(rows,scores);
    }
  }
}
console.log(JSON.stringify(result,null,2));
