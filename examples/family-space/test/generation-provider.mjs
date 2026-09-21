// Provider-only smoke: fixed synthetic input, no family reads and no user session.
import {chromium} from 'playwright';
const browser=await chromium.launch();
try {
 const page=await browser.newPage();
 await page.goto(process.env.KIN_BASE_URL ?? 'http://127.0.0.1:5227/');
 const result=await page.evaluate(async()=>{
   const {generateFamilyApp}=await import('/app-generator.ts');
   const {extractAppSource}=await import('/app-context.ts');
   const {compileFamilyApp}=await import('/app-preview.tsx');
   const started=Date.now();
   const text=await generateFamilyApp('Return a React app with a heading Synthetic test and a button that increments an in-memory counter. This is a test; no family information is provided.',JSON.stringify({family:'Synthetic test',members:[],posts:[],feed:[],schedule:[],chat:[],capturedAt:'2026-01-01T00:00:00Z'}),()=>{},new AbortController().signal);
   const source=extractAppSource(text);
   await compileFamilyApp(source);
   return {compiled:true,elapsedSeconds:Math.round((Date.now()-started)/1000)};
 });
 console.log(JSON.stringify(result));
} finally { await browser.close(); }
