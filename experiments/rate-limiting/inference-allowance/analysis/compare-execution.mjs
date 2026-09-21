import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export async function compareExecution(leftPath,rightPath){
    const json=async path=>JSON.parse(await readFile(path,'utf8'));
    async function load(path){
        const manifest=await json(join(path,'manifest.json'));
        if(manifest.captureKind!=='inference-execution-measurement'||manifest.status!=='complete')throw new Error('Incomplete or incompatible measurement: '+path);
        for(const file of manifest.files){
            const bytes=await readFile(join(path,file.path));
            if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Capture integrity failed: '+file.path);
        }
        const result=await json(join(path,'result.json'));
        const assessment=await json(join(path,'assessment.json'));
        if(!assessment.evidenceComplete)throw new Error('Incomplete evidence: '+path);
        return {result,assessment};
    }
    const left=await load(leftPath),right=await load(rightPath);
    for(const key of ['workloadHash','architectureHash'])if(!left.result.run[key]||left.result.run[key]!==right.result.run[key])throw new Error('Comparison mismatch: '+key);
    const observation=(cohort,id)=>{
        const row=cohort.assessment.http[id];
        return {outcomes:row.clientOutcomes,disconnected:row.disconnected,transactionAttempts:row.transactionAttempts,
            execution:row.execution,latencyByUserOutcome:row.latencyByUserOutcome,
            failedExpectations:cohort.result.assertions.filter(a=>a.caseId===id&&a.passed!==a.expectedPass).map(a=>({name:a.name,actual:a.actual,expected:a.expected}))};
    };
    return {comparableWorkload:true,performanceEquivalent:false,
        leftRun:left.result.run.id,rightRun:right.result.run.id,workloadHash:left.result.run.workloadHash,architectureHash:left.result.run.architectureHash,
        limitations:['Single bounded run per environment','Network, HTTP proxy and Firestore differ; timing is observational','Fake provider, not real AI Logic','Per-process execution limits, not distributed capacity'],
        cases:Object.fromEntries(left.result.run.selectedCases.map(id=>[id,{pyric:observation(left,id),firestoreCloudRun:observation(right,id)}]))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await compareExecution(process.argv[2],process.argv[3]),null,2));
