import { beforeAll, describe, expect, it } from 'bun:test';
import { deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';
import { renderScoreboardMarkdown } from '../../src/generate-docs.ts';

let model: ConformanceModel;
beforeAll(async () => {
  model = await deriveConformanceModel();
}, 60_000);

describe('generated conformance scoreboard', () => {
  it('publishes each Rules engine score from the canonical construct scorecards', () => {
    const markdown = renderScoreboardMarkdown(model);
    const rulesRow = markdown.match(
      /<tr class="compat-score-row--rules">[\s\S]*?<\/tr>/,
    )?.[0];

    expect(rulesRow).toBeDefined();
    expect(rulesRow).toContain('>Firestore Rules<');
    expect(rulesRow).toContain('>Storage Rules<');
    expect(rulesRow).toContain('>Realtime Database Rules<');
    expect(rulesRow).toContain('<span class="compat-score-pct">97.9%</span>');
    expect(rulesRow).toContain('137 of 140 rules-language constructs verified');
    expect(rulesRow).toContain('<span class="compat-score-pct">97.1%</span>');
    expect(rulesRow).toContain('67 of 69 rules-language constructs verified');
    expect(rulesRow).toContain('<span class="compat-score-pct">96.4%</span>');
    expect(rulesRow).toContain('54 of 56 rules-language constructs verified');
    expect(rulesRow).not.toContain('Gathering metrics');
  });

  it('keeps Overall scoped to the Firebase public API census', () => {
    const markdown = renderScoreboardMarkdown(model);
    const overallRow = markdown.match(
      /<tr class="compat-score-row--overall">[\s\S]*?<\/tr>/,
    )?.[0];

    expect(overallRow).toBeDefined();
    expect(overallRow).toContain('public API');
    expect(overallRow).not.toContain('rules-language constructs');
  });
});
