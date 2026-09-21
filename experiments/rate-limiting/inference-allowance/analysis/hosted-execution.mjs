import { assessExecution } from './execution-checks.mjs';
import { httpScenarios } from '../scenarios/http-overload.mjs';
import { summarizeHttp } from './http-summary.mjs';

// Same lifecycle expectations as local: divergences remain visible failures.
export function assessHostedExecution(result) {
    result.assertions=[];
    const issues=[];
    const completeness=[];
    const instanceIds=new Set(result.events.filter(e=>e.role==='server'||e.kind==='remote-case-ready'||e.kind==='remote-case-drained').map(e=>e.instanceId));
    if(instanceIds.size!==1||instanceIds.has(undefined))completeness.push('Run did not remain on one identified server instance');
    const server=result.events.filter(e=>e.role==='server');
    const sequences=server.map(e=>e.localSequence).sort((a,b)=>a-b);
    if(!sequences.length||sequences.some((n,i)=>!Number.isInteger(n)||(i>0&&n!==sequences[i-1]+1)))completeness.push('Server event sequence is missing or duplicated');
    for(const id of result.run.selectedCases){
        const scenario=httpScenarios[id];
        const events=result.events.filter(e=>e.caseId===id);
        const of=kind=>events.filter(e=>e.kind===kind);
        const check=(name,actual,expected,expectedPass=true)=>{
            const passed=JSON.stringify(actual)===JSON.stringify(expected);
            result.assertions.push({runId:result.run.id,caseId:id,name,actual,expected,passed,expectedPass});
            if(passed!==expectedPass)issues.push(`${id}: ${name}`);
            if(!passed&&['case completed','all scheduled requests observed','all server requests captured','all server responses captured','all work settles','single case instance','stable case process'].includes(name))completeness.push(`${id}: ${name}`);
        };
        check('case completed',result.cases.find(c=>c.id===id)?.status,'complete');
        check('all scheduled requests observed',of('client-response').length+of('client-disconnected').length,scenario.schedule.length);
        check('no client transport errors',of('client-error').length+of('client-ack-error').length,0);
        check('all server requests captured',of('request-start').length,scenario.schedule.length);
        check('all server responses captured',of('request-response').length,scenario.schedule.length);
        check('all work settles',new Set(of('request-work-settled').map(e=>e.attemptId)).size,scenario.schedule.length);
        const instances=[...new Set(of('request-start').map(e=>e.instanceId))];
        check('single case instance',instances.length,1);
        check('stable case process',instances[0],of('remote-case-ready')[0]?.instanceId);
        const statusCodes={completed:200,execution_busy:503,inference_timeout:504,quota_exhausted:429,admission_busy:503,
            admission_timeout:504,duplicate:200,outcome_unknown:500};
        check('HTTP status matches outcome',of('client-response').every(e=>e.httpStatus===(e.streamed?200:statusCodes[e.status])),true);
        const starts=of('request-start').map(e=>e.attemptId).sort();
        for(const kind of ['request-response','request-work-settled']){
            if(JSON.stringify(starts)!==JSON.stringify(of(kind).map(e=>e.attemptId).sort()))completeness.push(`${id}: unmatched ${kind}`);
        }
        for(const dispatch of of('inference-dispatch')){
            const matches=kind=>of(kind).filter(e=>e.attemptId===dispatch.attemptId&&e.instanceId===dispatch.instanceId);
            if(matches('provider-settled').length!==1||matches('provider-active').length!==2||matches('transaction-attempt').length<2)completeness.push(`${id}: incomplete provider lifecycle`);
        }
        assessExecution(events,scenario,check);
    }
    issues.push(...completeness);
    return {evidenceComplete:completeness.length===0,completenessIssues:completeness,successfulExperiment:issues.length===0,issues,expectedNegativeControls:result.assertions.filter(a=>!a.passed&&!a.expectedPass).length,http:summarizeHttp(result)};
}
