// The layout probe in Chromium on fixture pages: rows on a subgrid line up,
// rows with their own tracks don't; and the other three checks each catch
// their case. Launches Playwright's Chromium; no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { probeLayout, type LayoutFinding } from './layout-probe.ts';

const ALIGNMENT = readFileSync(fileURLToPath(new URL('./fixtures/alignment.html', import.meta.url)), 'utf8');
let browser: Browser;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });

async function probe(html: string, width = 1440): Promise<LayoutFinding[]> {
  const page: Page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(html);
  const findings = await page.evaluate(probeLayout);
  await page.close();
  return findings;
}

describe('column alignment', () => {
  test('rows on the parent\'s subgrid line up; rows with their own tracks are flagged by column', async () => {
    const misaligned = (await probe(ALIGNMENT)).filter((finding) => finding.rule === 'column-misaligned');
    expect(misaligned.every((finding) => finding.key.startsWith('section.list.own'))).toBe(true);
    expect(misaligned.map((finding) => finding.key)).toEqual(['section.list.own column 2', 'section.list.own column 3']);
  });

  test('role=list rows are compared too, through single-child wrappers', async () => {
    const html = `<ul role="list" style="display:grid;gap:4px;padding:0">
      <li style="display:block"><div style="display:flex;gap:8px"><span>a</span><span>b</span></div></li>
      <li style="display:block"><div style="display:flex;gap:8px"><span>longer</span><span>b</span></div></li></ul>`;
    const keys = (await probe(html)).filter((finding) => finding.rule === 'column-misaligned').map((finding) => finding.key);
    expect(keys).toEqual(['ul column 2']);
  });
});

describe('the other layout checks', () => {
  test('a page wider than the viewport scrolls sideways', async () => {
    const findings = await probe('<div style="width:600px">wide</div>', 390);
    expect(findings.map((finding) => finding.rule)).toContain('horizontal-scroll');
    expect((await probe('<div>fits</div>', 390)).map((finding) => finding.rule)).not.toContain('horizontal-scroll');
  });

  test('overlapping buttons are flagged, nested ones are not', async () => {
    const overlapping = '<div style="position:relative;height:40px"><button style="position:absolute;left:0;width:80px">One</button><button style="position:absolute;left:40px;width:80px">Two</button></div>';
    expect((await probe(overlapping)).filter((finding) => finding.rule === 'overlap')).toHaveLength(1);
    expect((await probe('<a href="#x"><button>Inside</button></a><button>Apart</button>')).filter((finding) => finding.rule === 'overlap')).toEqual([]);
  });

  test('text wider than its box is clipped', async () => {
    const clipped = '<p style="width:60px;overflow:hidden;white-space:nowrap">A title far too long for its box</p>';
    expect((await probe(clipped)).filter((finding) => finding.rule === 'clipped-text')).toHaveLength(1);
    expect((await probe('<p style="width:60px">Wraps fine</p>')).filter((finding) => finding.rule === 'clipped-text')).toEqual([]);
  });
});
