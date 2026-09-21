import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {validateKit,searchUi,readUi,checkUiPlan,catalog} from '../ui-kit';
import {selectUi} from '../ui-kit-selection';
const docs=JSON.parse(readFileSync(new URL('../seed.json',import.meta.url),'utf8')).firestore.firestore;
const kit=validateKit({version:'kin-v1',entries:Object.entries(docs).filter(([path])=>path.includes('/uiKits/kin-v1/entries/')).map(([,value])=>value) as any});
test('catalog excludes source; retrieval expands dependencies once',()=>{
 expect(JSON.stringify(catalog(kit))).not.toContain('function Button');
 const entries=readUi(kit,['persistent-records','button']);
 expect(entries.map(e=>e.id)).toEqual(['section-actions','button','field','card-list','feedback','persistent-records']);
 expect(()=>readUi(kit,['invented'])).toThrow('Unknown UI kit');
});
test('search and coverage identify missing and uncovered patterns',()=>{
 expect(searchUi(kit,['heading toolbar'])[0].matches[0].id).toBe('section-actions');
 expect(checkUiPlan(kit,['text input'],[])[0].suggestions).toContain('field');
 expect(checkUiPlan(kit,['geolocation'],[])[0].noMatch).toBe(true);
 const cycle=structuredClone(kit);cycle.entries[0].dependencies=[cycle.entries[0].id];
 expect(()=>validateKit(cycle)).toThrow('cycle');
});
test('selection retrieves source after planning and reports tool evidence',async()=>{
 const logs:string[]=[];
 const model={async generateContentStream(prompt:string){
  expect(prompt).not.toContain('function Button');
  const chunk={text:()=>JSON.stringify({needs:['text input','geolocation'],ids:['section-actions']})};
  return {response:Promise.resolve(chunk),stream:(async function*(){yield chunk;})()};
 }};
 const result=await selectUi(kit,'Plan a meal',model,new AbortController().signal,(name)=>logs.push(name));
 expect(result.ids).toContain('field');expect(result.gaps).toContain('geolocation');
 expect(result.context).toContain('function Field');
 expect(logs).toEqual(['search_ui','search_ui','check_ui_plan','read_ui']);
});
