// Shared Node/Express lifecycle for local and hosted experiment transports.
export async function respondToInference(req,res,{gateway,record,token,execution=false}) {
    const clientAttemptId=req.get('x-experiment-attempt');
    record('http-received',{clientAttemptId,requestId:req.body?.requestId});
    const disconnect=new AbortController();
    res.on('close',()=>{
        record('http-closed',{clientAttemptId,finished:res.writableFinished});
        if(execution&&!res.writableFinished)disconnect.abort();
    });
    let onChunk;
    if(execution&&req.get('accept')==='application/x-ndjson')onChunk=chunk=>{
        if(res.destroyed||res.writableEnded)return;
        if(!res.headersSent)res.status(200).type('application/x-ndjson');
        res.write(JSON.stringify({type:'chunk',index:chunk.index})+'\n');
    };
    const input={token,route:req.params.route,body:req.body};
    if(execution)Object.assign(input,{signal:disconnect.signal,onChunk});
    const result=await gateway.request(input);
    let httpStatus={completed:200,provider_cancelled:200,cancellation_requested:202,execution_busy:503,inference_timeout:504,client_cancelled:499,
        quota_exhausted:429,admission_busy:503,admission_timeout:504,unauthenticated:401,
        invalid_request:400,duplicate:200,conflict:409}[result.status]??500;
    if(res.headersSent)httpStatus=200;
    record('http-response',{clientAttemptId,status:result.status,httpStatus});
    if(!res.destroyed){
        if(res.headersSent)res.end(JSON.stringify({type:'result',...result})+'\n');
        else res.status(httpStatus).json(result);
    }
}

export async function respondToCancellation(req, res, { gateway, record, token }) {
    const clientAttemptId = req.get('x-experiment-attempt');
    let result;
    try { result = await gateway.cancel({ token, body: req.body }); }
    catch { result = { status: 'backend_failure' }; }
    const httpStatus = { cancellation_requested: 202, unauthenticated: 401, invalid_request: 400, not_found: 404 }[result.status] ?? 500;
    record('cancellation-response', { clientAttemptId, status: result.status, httpStatus });
    res.status(httpStatus).json(result);
}
