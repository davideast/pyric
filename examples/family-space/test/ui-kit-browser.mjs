import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch();
const origin = process.env.KIN_BASE_URL ?? "http://127.0.0.1:5227/";
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const Native = window.SharedWorker;
    window.SharedWorker = class extends Native {
      constructor(url, options) {
        if (String(url).includes("generation-shared-worker.ts"))
          url = new URL("/test/resumable-worker.ts", location.href);
        super(url, options);
      }
    };
  });
  const login = await context.newPage();
  await login.goto(origin);
  await login.getByLabel("Email", { exact: true }).fill("emma@kin.example");
  await login
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  let [page] = await Promise.all([
    context.waitForEvent("page"),
    login.getByRole("link", { name: "Open sign-in link" }).click(),
  ]);
  await page
    .getByRole("heading", { name: "Our family", exact: true })
    .waitFor();
  await login.close();
  page.on("pageerror", (error) => console.log("PAGE ERROR", error.message));
  await page.evaluate(async()=>{
    const {db,base}=await import('/data.ts');
    const text=await fetch('/data.ts').then(r=>r.text());
    const sdkPath=text.match(/from "([^"]*entries\/firestore.js[^"]*)"/)[1];
    const {getDocs,collection,doc,runTransaction}=await import(sdkPath);
    const {loadInstalledUiKit}=await import('/ui-kit-upgrade.ts');
    const path=base+'/uiKits/upgrade-browser/entries';
    const store={
      async read(){return (await getDocs(collection(db,path))).docs.map(d=>({...d.data(),id:d.id}));},
      async installMissing(entries){await runTransaction(db,async tx=>{const snapshots=await Promise.all(entries.map(e=>tx.get(doc(db,path+'/'+e.id))));entries.forEach((e,i)=>{if(!snapshots[i].exists())tx.set(doc(db,path+'/'+e.id),e);});});}
    };
    const kit=await loadInstalledUiKit(store,async()=>fetch('/ui-kit/kin-v1.json').then(r=>r.json()));
    if(kit.entries.length!==7)throw new Error('Browser migration failed');
    await loadInstalledUiKit(store,async()=>{throw new Error('Unexpected second installation');});
  });
  const entries=await page.evaluate(async () => (await (await import('/ui-kit-store.ts')).loadUiKit()).entries);
  assert.equal(entries.length,7);
  for (const entry of entries) {
    const result=await page.evaluate(async ({entries,id})=>{
      const {readUi}=await import('/ui-kit.ts');
      const selected=readUi({version:'kin-v1',entries},[id]);
      const source=selected.map(e=>e.source).join('\n')+'\nexport default function App(){return <main style={{padding:20,display:"grid",gap:24}}>'+selected.at(-1).example+'</main>}';
      const {compileFamilyApp}=await import('/app-compiler.ts');await compileFamilyApp(source);
      const {db,base}=await import('/data.ts');
      const text=await fetch('/data.ts').then(r=>r.text());
      const sdkPath=text.match(/from "([^"]*entries\/firestore.js[^"]*)"/)[1];
      const {setDoc,doc}=await import(sdkPath);
      await setDoc(doc(db,base+'/apps/kit-'+id),{ownerId:'emma',title:'Kit '+id,prompt:'Verify reference',source,context:'{}',audience:['emma'],createdAt:Date.now(),published:false});
      return id;
    },{entries,id:entry.id});
    await page.goto(origin+'#apps/kit-'+result);
    await page.getByText('App started successfully',{exact:true}).waitFor();
  }
  console.log('PASS all seven Firestore reference patterns compile and mount in isolated preview');
} finally {await browser.close();}
