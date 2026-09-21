import {validateKit,type KitEntry,type UiKit} from './ui-kit';
export const KIT_VERSION='kin-v1';
export const KIT_IDS=['section-actions','button','field','card-list','feedback','disclosure','persistent-records'];
export interface KitStore {
 read():Promise<KitEntry[]>;
 installMissing(entries:KitEntry[]):Promise<void>;
}
/** Deployment data is only used to migrate Firestore. Consumers always read Firestore. */
export async function loadInstalledUiKit(store:KitStore, deployment:()=>Promise<UiKit>):Promise<UiKit> {
 let entries=await store.read();
 const missing=KIT_IDS.filter(id=>!entries.some(e=>e.id===id));
 if(missing.length){
  const seed=validateKit(await deployment());
  if(seed.version!==KIT_VERSION || KIT_IDS.some(id=>!seed.entries.some(e=>e.id===id))) throw new Error('The deployed UI kit is incomplete. Reload Kin or contact its developer.');
  await store.installMissing(seed.entries.filter(e=>missing.includes(e.id)));
  entries=await store.read();
 }
 if(KIT_IDS.some(id=>!entries.some(e=>e.id===id))) throw new Error('UI kit installation did not finish. Retry the build.');
 try {return validateKit({version:KIT_VERSION,entries});}
 catch(error){throw new Error('The saved UI kit is invalid. Its existing entries were preserved; contact the developer to repair the kit.',{cause:error});}
}
