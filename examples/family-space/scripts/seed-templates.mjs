// One authoring output supplies both fresh sandbox seeds and existing installs.
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const catalog=JSON.parse(await readFile(new URL('templates/catalog.json',root)));
const templates=await Promise.all(catalog.map(async t=>({...t,source:await readFile(new URL(`templates/generated/${t.id}.tsx`,root),'utf8'),version:t.version??1})));
if(templates.length!==10||templates.filter(t=>t.tone==='practical').length!==7)throw new Error('Expected seven practical templates and three games');
const seed=JSON.parse(await readFile(new URL('seed.json',root)));
for(const {id,...data} of templates)seed.firestore.firestore[`families/parkers/appTemplates/${id}`]=data;
await writeFile(new URL('seed.json',root),JSON.stringify(seed,null,2)+'\n');
await writeFile(new URL('public/app-templates.json',root),JSON.stringify(templates,null,2)+'\n');
console.log('Seeded 10 app templates');
