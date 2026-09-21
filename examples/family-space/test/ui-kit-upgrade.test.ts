import 'fake-indexeddb/auto';
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {initializeSandbox} from 'pyric/sandbox';
import {seedDocuments,setRules} from 'pyric/sandbox/firestore';
import {getFirestore,collection,getDocs,doc,getDoc,runTransaction} from 'pyric/firestore';
import {type KitEntry} from '../ui-kit';
import {loadInstalledUiKit} from '../ui-kit-upgrade';
const seed=JSON.parse(readFileSync(new URL('../seed.json',import.meta.url),'utf8')).firestore.firestore;
const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
test('an existing family sandbox can load the new UI kit without resetting its data',async()=>{
 const sandbox=initializeSandbox();
 const old=Object.fromEntries(Object.entries(seed).filter(([path])=>!path.includes('/uiKits/')));
 seedDocuments(sandbox,old);setRules(sandbox,rules);
 const db=getFirestore(sandbox.withAuth({uid:'emma'}));
 const path='families/parkers/uiKits/kin-v1/entries';
 const store={
  async read(){return (await getDocs(collection(db,path))).docs.map(d=>({...d.data(),id:d.id}) as KitEntry);},
  async installMissing(entries:KitEntry[]){await runTransaction(db,async tx=>{const docs=await Promise.all(entries.map(e=>tx.get(doc(db,path+'/'+e.id))));entries.forEach((e,i)=>{if(!docs[i].exists())tx.set(doc(db,path+'/'+e.id),e);});});}
 };
 const deployment=async()=>JSON.parse(readFileSync(new URL('../public/ui-kit/kin-v1.json',import.meta.url),'utf8'));
 const kit=await loadInstalledUiKit(store,deployment);
 expect(kit.entries.length).toBe(7);
 const repeated=await loadInstalledUiKit(store,async()=>{throw new Error('Complete Firestore kit must not reload deployment data');});
 expect(repeated).toEqual(kit);
 expect((await getDoc(doc(db,"families/parkers/members/emma"))).data()).toEqual(old["families/parkers/members/emma"]);
});
