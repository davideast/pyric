import { chromium, expect } from '@playwright/test';
const browser=await chromium.launch({headless:true});
let cleanup;
const request=await browser.newContext();
try {
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 await page.goto('http://localhost:5197/?service=rtdb');
 const init=await (await request.request.get('http://localhost:5197/__pyric/init.json')).json();
 const headers={'x-pyric-session-token':init.sessionToken};
 const endpoint='http://localhost:5197/__pyric/thresholds';
 const original=await (await request.request.get(endpoint,{headers})).json();
 cleanup=async () => {
  const current=await (await request.request.get(endpoint,{headers})).json();
  const saved=await request.request.put(endpoint,{headers,data:{config:original.config,revision:current.revision}});
  expect(saved.ok()).toBe(true);
 };
 await page.getByRole('tab',{name:'Traffic',exact:true}).click();
 await page.getByRole('button',{name:'Rates',exact:true}).click();
 await page.getByRole('button',{name:'Realtime Database',exact:true}).click();
 await page.getByRole('button',{name:'More actions',exact:true}).click();
 await page.getByRole('button',{name:'Thresholds…',exact:true}).click();
 await expect(page.locator('[data-threshold-input=writes]')).toBeEnabled();
 await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1100});
  await page.screenshot({path:`/tmp/threshold-settings-rtdb-${width}.png`});
  expect(await page.locator('.threshold-settings').evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(false);
 }
 await page.setViewportSize({width:1440,height:1100});
 await page.locator('[data-threshold-input=writes]').fill('1');
 await page.locator('[data-threshold-input=deliveries]').fill('');
 await page.locator('[data-threshold-input=sustainedSeconds]').fill('2');
 await expect(page.locator('[data-threshold-equivalent=writes]')).toHaveText('60/min');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.locator('[data-rate-detail=rtdb]')).toBeVisible();
 await page.getByRole('button',{name:'Minimize pyric',exact:true}).click();
 for(let i=0;i<35;i++) { await page.getByRole('button',{name:'Presence',exact:true}).click(); await page.waitForTimeout(100); }
 await expect(page.locator('.chip.warning')).toBeVisible({timeout:8000});
 await page.getByRole('button',{name:'Open pyric',exact:true}).click();
 await page.locator('[data-rate-incidents=rtdb]').click();
 await expect(page.locator('[data-rate-incident]')).toHaveCount(1);
 await page.locator('[data-rate-incident]').click();
 await expect(page.getByRole('button',{name:'Resume live',exact:true})).toBeVisible();
 await expect(page.locator('[data-history-summary]')).toContainText('Selected period');
 await expect(page.locator('.history-warning')).toHaveCount(1);
 await page.screenshot({path:'/tmp/threshold-incident.png'});
 await page.getByRole('button',{name:'More actions',exact:true}).click();
 await page.getByRole('button',{name:'Thresholds…',exact:true}).click();
 await expect(page.locator('[data-threshold-input=writes]')).toHaveValue('1');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Services',exact:true}).click();
 await page.getByRole('button',{name:'Firestore',exact:true}).click();
 await page.getByRole('button',{name:'More actions',exact:true}).click();
 await page.getByRole('button',{name:'Thresholds…',exact:true}).click();
 await expect(page.locator('[data-threshold-input=documentReads]')).toBeEnabled();
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1100});
  await page.screenshot({path:`/tmp/threshold-settings-firestore-${width}.png`});
  expect(await page.locator('.threshold-settings').evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(false);
 }
 await page.setViewportSize({width:1440,height:1100});
 await page.getByRole('button',{name:'Use defaults',exact:true}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('button',{name:'Minimize pyric',exact:true}).click();
 await page.locator('#chat-service').selectOption('firestore');
 await page.getByRole('button',{name:'Minimize pyric',exact:true}).click();
 await page.getByRole('button',{name:'Test rate warning',exact:true}).click();
 await expect(page.locator('.chip.warning')).toBeVisible({timeout:15000});
 await page.getByRole('button',{name:'Open pyric',exact:true}).click();
 await page.locator('[data-rate-incidents=firestore]').click();
 await expect(page.locator('[data-rate-incident]')).toContainText('Document writes');
 await page.locator('[data-rate-incident]').click();
 await expect(page.locator('[data-history-total=writes]')).not.toHaveText('0');
 await expect(page.getByRole('button',{name:'Test rate warning',exact:true})).toBeEnabled({timeout:15000});
 await page.getByRole('button',{name:'More actions',exact:true}).click();
 await page.getByRole('button',{name:'Thresholds…',exact:true}).click();
 await page.locator('[data-threshold-input=documentReads]').fill('31');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.reload();
 await page.getByRole('tab',{name:'Traffic',exact:true}).click();
 await page.getByRole('button',{name:'Rates',exact:true}).click();
 await page.getByRole('button',{name:'Firestore',exact:true}).click();
 await page.getByRole('button',{name:'More actions',exact:true}).click();
 await page.getByRole('button',{name:'Thresholds…',exact:true}).click();
 await expect(page.locator('[data-threshold-input=documentReads]')).toHaveValue('31');
 console.log('PASS: settings, equivalents, persistence, amber, alert selection, chart evidence, both services and narrow layout');
} finally { try { await cleanup?.(); } finally { await browser.close(); } }
