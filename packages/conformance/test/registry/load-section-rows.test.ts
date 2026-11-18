import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from '../../registry/load-section-rows.ts';
import sampleFirstRow from './sample-surface/alpha/first-row.ts';
import { section as sampleAlphaSection } from './sample-surface/alpha/section.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('loadRegistrySections filesystem loader', () => {
  it('loads authored TypeScript section and row modules from disk', () => {
    expect(sampleAlphaSection.order).toBe(10);
    expect(sampleFirstRow.order).toBe(10);

    const loaded = loadRegistrySections(join(HERE, 'sample-surface'));
    expect(loaded.blocks).toHaveLength(1);
    expect(loaded.blocks[0]?.prefix).toBe('## Sample section\n');
    expect(loaded.rowsOf('alpha').map((row) => row.id)).toEqual(['ai#first-row']);
  });
});
