// Verify shipped samples through Kin's normal create-copy and iframe workflow.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const catalog=JSON.parse(await readFile(new URL('../templates/catalog.json',import.meta.url)));
const browser=await chromium.launch();
const origin=process.env.KIN_BASE_URL??'http://127.0.0.1:5227/';
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 const login=await context.newPage();await login.goto(origin);
 await login.getByLabel('Email',{exact:true}).fill('emma@kin.example');
 await login.getByRole('button',{name:'Send sign-in link',exact:true}).click();
 const [page]=await Promise.all([context.waitForEvent('page'),login.getByRole('link',{name:'Open sign-in link'}).click()]);
 page.on('console',msg=>{if(msg.type()==='error')console.log('BROWSER',msg.text().slice(0,180));});
 await page.getByRole('heading',{name:'Our family',exact:true}).waitFor();await login.close();
 await page.goto(origin+'#apps');
 await page.getByRole('button',{name:'Use Dinner Spinner template',exact:true}).waitFor();
 assert.equal(await page.locator('.template-row').count(),10);
 assert.equal(await page.locator('.template-group').first().locator('.template-row').count(),7);
 await page.screenshot({path:'/tmp/kin-templates-desktop.png',fullPage:true});
 const checks={
  'dinner-spinner':async f=>{await f.getByLabel('Dinner option',{exact:true}).fill('Test tacos');await f.getByRole('button',{name:'Add dinner',exact:true}).click();await f.getByRole('checkbox',{name:'Test tacos'}).waitFor();await f.getByRole('button',{name:'Spin dinner',exact:true}).click();await f.getByRole('heading',{name:'Test tacos',exact:true}).waitFor();},
  'chore-quest':async f=>{await f.getByLabel('Chore',{exact:true}).fill('Test chore');await f.getByRole('button',{name:'Add chore',exact:true}).click();await f.getByText('Test chore',{exact:true}).waitFor();},
  'weekend-picker':async f=>{await f.getByLabel('Activity idea',{exact:true}).fill('Test picnic');await f.getByRole('button',{name:'Add idea',exact:true}).click();await f.getByText('Test picnic',{exact:true}).first().waitFor();},
  'pack-and-go':async f=>{await f.getByLabel('Packing item',{exact:true}).fill('Test blanket');await f.getByRole('button',{name:'Add item',exact:true}).click();await f.getByText('Test blanket',{exact:true}).waitFor();},
  'kindness-jar':async f=>{await f.getByLabel('Kindness note',{exact:true}).fill('Thanks for helping!');await f.getByRole('button',{name:'Add kindness',exact:true}).click();await f.locator('p').filter({hasText:'Thanks for helping!'}).waitFor();},
  'reading-trail':async f=>{await f.getByLabel('Book title',{exact:true}).fill('Test story');await f.getByRole('button',{name:'Add book',exact:true}).click();await f.getByText('Test story',{exact:true}).waitFor();},
  'time-capsule':async f=>{await f.getByLabel('Memory',{exact:true}).fill('Our test picnic');await f.getByLabel('Open on',{exact:true}).fill('2099-01-01');await f.getByRole('button',{name:'Save memory',exact:true}).click();await f.getByText('🔒 Unlocks on 2099-01-01',{exact:true}).waitFor();},
  'story-relay':async f=>{await f.getByRole('button',{name:'Start a story',exact:true}).click();await f.getByLabel(/^Your sentence/).fill('Once upon a test.');await f.getByRole('button',{name:'Add sentence',exact:true}).click();await f.getByText('Once upon a test.',{exact:true}).first().waitFor();},
  'connect-four':async f=>{await f.getByRole('button',{name:'New Game',exact:true}).click();for(const col of [1,2,1,2,1,2,1])await f.getByRole('button',{name:'Drop in column '+col,exact:true}).click();await f.getByText(/Winner:/).waitFor();},
  'family-trivia':async f=>{await f.getByRole('button',{name:'Start quiz',exact:true}).click();for(const answer of ['56','Camel','8','Bat','The Sun']){await f.getByRole('button',{name:new RegExp('^[A-D]\\. '+answer+'$')}).click();await f.getByRole('button',{name:/Next Question|View Final Scores/}).click();}await f.getByText(/Round Complete/).waitFor();await f.getByLabel('Playing as:').selectOption('emma');await f.getByText('What is 7 multiplied by 8?',{exact:true}).waitFor();}
 };
 for(const t of catalog.filter(t=>!process.env.TEMPLATE_ID||t.id===process.env.TEMPLATE_ID)){
  await page.goto(origin+'#apps');await page.getByRole('button',{name:`Use ${t.title} template`,exact:true}).click();
  await page.getByRole('button',{name:'Create from template',exact:true}).click();
  await page.getByText('App started successfully',{exact:true}).waitFor({timeout:30000});
  const f=page.frameLocator('iframe[title="Family app preview"]');
  try{await checks[t.id](f);}catch(e){console.log('INTERACTION FAILED',t.id,await f.locator('body').innerText());throw e;}
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`/tmp/kin-template-${t.id}-mobile.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),t.id+' host overflow');
  const iframe=page.frames().find(f=>f!==page.mainFrame());
  assert.ok(await iframe.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),t.id+' preview overflow');
  await page.reload();await page.getByText('App started successfully',{exact:true}).waitFor({timeout:30000});
  const restored={'dinner-spinner':'Test tacos','chore-quest':'Test chore','weekend-picker':'Test picnic','pack-and-go':'Test blanket','kindness-jar':'Thanks for helping!','reading-trail':'Test story','time-capsule':'2099-01-01','story-relay':'Once upon a test.','connect-four':'Winner:','family-trivia':'Round'}[t.id];
  await f.getByText(restored,{exact:false}).filter({visible:true}).first().waitFor();
  console.log('PASS',t.id);
  await page.setViewportSize({width:1440,height:1100});
 }
}finally{await browser.close();}
