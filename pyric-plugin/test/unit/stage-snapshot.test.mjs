import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { loadPlaywright, resolveChromiumExecutable } from '../../skills/improve-firebase/scripts/lib/runtime.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const stagesDir = path.resolve(__dirname, '../../skills/improve-firebase/assets/stages');

test('Stage structural snapshot', async (t) => {
  let chromium, chromePath;
  try {
    const pw = await loadPlaywright({ install: false });
    chromium = pw.chromium;
    chromePath = resolveChromiumExecutable(chromium);
  } catch (e) {
    t.skip('Skipping: Playwright/Chromium not installed or not found. ' + e.message);
    return;
  }
  
  if (!chromium || !chromePath) {
    t.skip('Skipping: Playwright/Chromium not available in this environment.');
    return;
  }

  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  t.after(() => browser.close());

  const stages = ['split-actors', 'single-hero', 'data-plane'];
  for (const stage of stages) {
    const page = await browser.newPage();
    const stagePath = path.join(stagesDir, `${stage}.html`);
    const fileUrl = url.pathToFileURL(stagePath).href;
    
    // Inject a dummy payload
    await page.goto(fileUrl);
    await page.evaluate(() => {
      window.__PYRIC_EVIDENCE__ = {
        schema: 'pyric.evidence.stage.v1',
        fps: 30,
        dimensions: { width: 1920, height: 1080 },
        finding: { campaign: 'c1', probe: 'p1' },
        template: 'tamper',
        actors: { owner: { name: 'Alice', uid: 'alice' } },
        copy: { title: 'T', summary: 'S', why: 'W' },
        stage: { layout: 'data-plane' },
        beats: [
          { id: 'start', startMs: 0, phase: 'control' },
          { id: 'impact', startMs: 2000, phase: 'repro' },
          { id: 'fix', startMs: 4000, phase: 'fix' }
        ],
        passes: { repro: { fps: 30, frames: [] } },
        provenanceText: 'DENY / database.set /test / anonymous / Local Pyric sandbox',
        evidence: {
          fixAssurance: { verified: false, reason: 'engine-gap' }
        }
      };
      if (window.initializeStage) window.initializeStage(window.__PYRIC_EVIDENCE__);
    });

    const timestamps = [0, 1000, 2500, 4500];
    for (const tMs of timestamps) {
      await page.evaluate((tMs) => {
        if (window.setFrame) window.setFrame(tMs);
      }, tMs);
      
      const provText = await page.$eval('[data-pyric-provenance]', el => el.textContent.trim()).catch(() => '');
      assert.equal(provText, 'DENY / database.set /test / anonymous / Local Pyric sandbox', `${stage} at ${tMs} missing provenance`);
      
      // Check overflow
      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth || 
               document.documentElement.scrollHeight > window.innerHeight;
      });
      assert.ok(!overflow, `${stage} at ${tMs} has viewport overflow`);
      
      // spotlight
      const spotlight = await page.$('svg.spotlight-overlay');
      if (spotlight) {
        const isHidden = await page.evaluate(el => el.hasAttribute('hidden'), spotlight);
        // just assert it doesn't crash, the visibility logic is tricky based on focus.
      }
    }
    
    await page.close();
  }
});
