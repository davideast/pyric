import {collection,doc,getDocs,runTransaction} from 'firebase/firestore';
import {db,base} from './data';
import {type KitEntry} from './ui-kit';
import {KIT_VERSION,loadInstalledUiKit} from './ui-kit-upgrade';
export async function loadUiKit() {
 const path=base+'/uiKits/'+KIT_VERSION+'/entries';
 return loadInstalledUiKit({
  async read(){const snapshot=await getDocs(collection(db,path));return snapshot.docs.map(d=>({...d.data(),id:d.id}) as KitEntry);},
  async installMissing(entries){
   await runTransaction(db,async transaction=>{
    const documents=await Promise.all(entries.map(e=>transaction.get(doc(db,path+'/'+e.id))));
    entries.forEach((entry,i)=>{if(!documents[i].exists())transaction.set(doc(db,path+'/'+entry.id),entry);});
   });
  },
 },async()=>{
  const response=await fetch('/ui-kit/'+KIT_VERSION+'.json');
  if(!response.ok)throw new Error('Could not load the UI kit installation data. Check your connection and retry.');
  return response.json();
 });
}
