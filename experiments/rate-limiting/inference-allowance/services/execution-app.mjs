import {respondToInference} from './inference-http.mjs';
import express from 'express';
import { createGateway } from '../architecture/gateway.mjs';
import { lifecycleInference } from './lifecycle-inference.mjs';
import { httpScenarios, httpWorkload } from '../scenarios/http-overload.mjs';
import policies from '../fixtures/policies.json' with { type:'json' };

// Operator-only experiment router. Workloads/configuration are fixed in captured
// source. A header selects a synthetic actor; it is not Firebase user identity.
export function createExecutionApp({createStore, record, runId, instanceId, environment}) {
    const cases = new Map();
    const caseIds = Object.keys(httpScenarios).filter(id=>httpScenarios[id].execution);
    let requests=0, closing=false;
    const resolveCase = id => {
        if (!cases.has(id)) cases.set(id,(async()=>{
            const scoped=(kind,data={})=>record(kind,{...data,caseId:id});
            const store=await createStore(id,scoped);
            const scenario=httpScenarios[id];
            const gateway=createGateway({store, record:scoped, policies, instanceId,
                clock:{now:()=>httpWorkload.clockStart}, ...scenario.options,
                authenticate:async uid=>/^(alice|bob|carol|dave|eve|user(?:[0-9]|1[0-9]))$/.test(uid??'') ? uid : null,
                inference:lifecycleInference(scoped,scenario.provider)});
            return {gateway,record:scoped};
        })());
        return cases.get(id);
    };
    const app=express();
    app.disable('x-powered-by');app.use(express.json({limit:'4kb',strict:true}));
    app.get('/health',(_req,res)=>res.status(closing?503:200).json({...environment,runId,instanceId,
        inference:'fake-lifecycle',clock:'controlled admission clock',cases:caseIds,
        authentication:'Cloud Run IAM operator; synthetic user header',requestsObserved:requests,requestCeilingPerInstance:250}));
    app.use('/cases/:caseId', async (req,res,next)=>{
        if (!caseIds.includes(req.params.caseId)) return res.sendStatus(404);
        if(closing) return res.sendStatus(503);
        try { res.locals.case=await resolveCase(req.params.caseId);next(); } catch(error){next(error);}
    });
    app.get('/cases/:caseId/health',(_req,res)=>res.json({instanceId,ready:true}));
    app.post('/cases/:caseId/drain',async(_req,res)=>{
        await res.locals.case.gateway.drain();
        res.locals.case.record('case-drained');res.json({instanceId,drained:true});
    });
    app.post('/cases/:caseId/observations/chunk',(req,res)=>{
        res.locals.case.record('client-chunk-acknowledged',{clientAttemptId:req.body.clientAttemptId,index:req.body.index});
        res.sendStatus(204);
    });
    app.post('/cases/:caseId/infer/:route',async(req,res)=>{
        if (requests>=250) return res.status(503).json({status:'experiment_unavailable'});
        requests++;
        const {gateway,record:trace}=res.locals.case;
        await respondToInference(req,res,{gateway,record:trace,token:req.get('X-Experiment-User'),execution:true});
    });
    app.use((error,_req,res,_next)=>res.status(400).json({status:'invalid_request'}));
    return {app,stopAdmission:()=>{closing=true;},drain:async()=>{
        for(const pending of cases.values())await (await pending).gateway.drain();
    }};
}
