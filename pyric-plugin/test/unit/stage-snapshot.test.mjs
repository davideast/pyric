import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import url from 'node:url';
import { loadPlaywright, resolveChromiumExecutable } from '../../skills/improve-firebase/scripts/lib/runtime.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const stagesDir = path.resolve(__dirname, '../../skills/improve-firebase/assets/stages');

test('Stage structural snapshot', async (t) => {
  let chromium, chromePath;
  try {
    const pw = await loadPlaywright({ install: false, projectDir: path.resolve(__dirname, '../../..') });
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
    
    // Inject a deterministic payload
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
        slides: [
          { id: 'title', kind: 'slide', startSec: 0, endSec: 1 },
          { id: 'problem-video', kind: 'video', startSec: 1, endSec: 2, uiOverlays: { focusAfter: { owner: { w: 100, h: 100, x: 0, y: 0, vw: 1000, vh: 750 } } } },
          { id: 'fix-slide', kind: 'slide', startSec: 2, endSec: 3, assuranceNote: 'engine gap' },
          { id: 'fix-video', kind: 'video', startSec: 3, endSec: 4, assuranceNote: 'engine gap' },
          { id: 'no-gap', kind: 'slide', startSec: 4, endSec: 5 },
          { id: 'state-slide', kind: 'slide', variant: 'state', startSec: 5, endSec: 6, stateBefore: { "foo": "bar" }, stateAfter: { "foo": "baz" }, highlightKeys: ["foo"] }
        ],
        passes: { repro: { fps: 30, frames: [] } },
        provenanceText: 'DENY / database.set /test / anonymous / Local Pyric sandbox',
        evidence: {
          fixAssurance: { verified: false, reason: 'engine-gap' }
        }
      };
      if (window.initializeStage) window.initializeStage(window.__PYRIC_EVIDENCE__);
    });

    const totalFrames = 180; // 6 seconds at 30 fps
    const testCases = [
      { tSec: 0.5, slideId: 'title', focusOwner: false, hasGap: false },
      { tSec: 1.5, slideId: 'problem-video', focusOwner: true, hasGap: false },
      { tSec: 2.5, slideId: 'fix-slide', focusOwner: false, hasGap: true },
      { tSec: 3.5, slideId: 'fix-video', focusOwner: false, hasGap: true },
      { tSec: 4.5, slideId: 'no-gap', focusOwner: false, hasGap: false },
      { tSec: 5.5, slideId: 'state-slide', focusOwner: false, hasGap: false }
    ];

    for (const tc of testCases) {
      const frameIndex = Math.floor(tc.tSec * 30);
      await page.evaluate(([tSec, frameIndex, totalFrames]) => {
        if (window.setFrame) window.setFrame(tSec, frameIndex, totalFrames);
      }, [tc.tSec, frameIndex, totalFrames]);
      
      const provText = await page.$eval('[data-pyric-provenance]', el => el.textContent.trim()).catch(() => '');
      assert.equal(provText, 'DENY / database.set /test / anonymous / Local Pyric sandbox', `${stage} at ${tc.tSec}s missing provenance`);
      
      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth || 
               document.documentElement.scrollHeight > window.innerHeight;
      });
      assert.ok(!overflow, `${stage} at ${tc.tSec}s has viewport overflow`);
      
      // Check spotlight
      const ownerSpotlight = await page.$('svg[data-actor-spotlight="owner"]');
      if (ownerSpotlight) {
        const isHidden = await page.evaluate(el => el.hasAttribute('hidden'), ownerSpotlight);
        if (tc.slideId.includes('video')) {
          if (tc.focusOwner) {
            assert.ok(!isHidden, `${stage} at ${tc.tSec}s: spotlight should NOT be hidden`);
          } else {
            assert.ok(isHidden, `${stage} at ${tc.tSec}s: spotlight should be hidden`);
          }
        }
      }

      // Check engine gap note
      // Try to find the element that has the assurance text or id
      if (stage === 'split-actors') {
        const isNoteVisible = await page.evaluate(() => {
           const s1 = document.getElementById('slideAssuranceNote');
           const s2 = document.getElementById('videoAssuranceNote');
           const isVisible = (el) => el && el.offsetParent !== null && !el.hidden && el.textContent.includes('engine gap');
           return isVisible(s1) || isVisible(s2);
        });
        if (tc.hasGap) {
          assert.ok(isNoteVisible, `${stage} at ${tc.tSec}s: engine gap note should be visible`);
        } else {
          assert.ok(!isNoteVisible, `${stage} at ${tc.tSec}s: engine gap note should NOT be visible`);
        }
      }
    }
    await page.close();
  }
});
