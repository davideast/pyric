// Real AI transport, UI retrieval, resumable generation and workspace compilation.
// Only synthetic context is sent to the model.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('templates/catalog.json', root)));
const kit = JSON.parse(await readFile(new URL('public/ui-kit/kin-v1.json', root)));
const context = JSON.stringify({family:'Example family',members:[{id:'parent-one',name:'Alex',role:'parent'},{id:'parent-two',name:'Robin',role:'parent'},{id:'kid-one',name:'Sky',role:'kid'},{id:'kid-two',name:'Riley',role:'kid'}],posts:[],feed:[],schedule:[],chat:[],capturedAt:'2026-09-16T00:00:00Z'});
const browser=await chromium.launch();
await mkdir(new URL('templates/generated/',root),{recursive:true});
try {
 const page=await browser.newPage();await page.goto(process.env.KIN_BASE_URL??'http://127.0.0.1:5227/');
 for(const item of catalog.filter(i=>!process.env.TEMPLATE_ID||i.id===process.env.TEMPLATE_ID)){
  try{await readFile(new URL(`templates/generated/${item.id}.tsx`,root));console.log('EXISTS',item.id);continue;}catch{}
  console.log('GENERATING',item.id);
  const result=await page.evaluate(async({item,kit,context})=>{
   const {generationClient,generationControl}=await import('/src/apps/generation/durable-generation.ts');
   await generationControl('active','');const client=generationClient();
   const {searchUi,checkUiPlan,readUi}=await import('/ui-kit.ts');
   const needs=['persistent records','layout','form fields','loading and errors'];
   const ids=['persistent-records','section-actions','field','feedback'];
   const search=searchUi(kit,needs),coverage=checkUiPlan(kit,needs,ids),entries=readUi(kit,ids);
   const uiSelection={needs,ids:entries.map(e=>e.id),gaps:coverage.filter(c=>c.noMatch).map(c=>c.need),context:JSON.stringify({kitVersion:kit.version,entries})};
   const {jobId}=await client.start({id:crypto.randomUUID(),ownerId:'template-authoring',title:item.title,prompt:item.prompt+'\nBuild a polished reusable starter matching Kin: aligned left headings, white/pale canvas, blue primary actions, 16-24px spacing, responsive max-width 760px, no external assets. Include loading/error/empty/pending states; catch mutations. Use only documented imports. All writes require a user action. Never embed the sample family in source; use family prop. Keep under 180 lines if possible.',context,audience:[],createdAt:Date.now(),uiKit:kit,uiSelection});
   let last;for await(const event of client.subscribe(jobId)){if(event.kind==='event')last=event.value;}
   if(!last?.job.draft)throw new Error(last?.job.error??'No generated app');
   return {source:last.job.draft.source,events:last.job.events,selection:last.spec.uiSelection,tools:{search,coverage}};
  },{item,kit,context});
  await writeFile(new URL(`templates/generated/${item.id}.tsx`,root),result.source);
  await writeFile(new URL(`templates/generated/${item.id}.evidence.json`,root),JSON.stringify({events:result.events.map(e=>({kind:e.kind,title:e.title})),selection:result.selection?.ids,tools:result.tools},null,2));
  console.log('GENERATED',item.id,result.source.length);
 }
}finally{await browser.close();}
