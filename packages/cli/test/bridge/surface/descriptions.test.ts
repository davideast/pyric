/**
 * The generated descriptions: what `tools/list` serves is rendered from the
 * records, groups the signatures by effect, and stays inside the size budget
 * the surface design fixes.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOOL_DESCRIPTIONS } from '../../../src/bridge/surface/descriptions.generated.js';
import { renderDescriptionModule } from '../../../scripts/generate-surface-descriptions.js';
import { METHODS, TOOLS } from '../../../src/bridge/surface/methods/registry.js';
import { renderSurface } from '../../../src/bridge/surface/index.js';
import {
  DESCRIPTION_LIMIT,
  renderToolDescriptions,
} from '../../../src/bridge/surface/tool-description.js';

const GENERATED_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'src',
  'bridge',
  'surface',
  'descriptions.generated.ts',
);

/** Four characters to the token, the rule the surface design budgets by. */
const CHARACTERS_PER_TOKEN = 4;
const LISTING_TOKEN_BUDGET = 5000;

describe('the generated tool descriptions', () => {
  it('regenerates to exactly what is in the tree', () => {
    const rendered = renderDescriptionModule(renderToolDescriptions(TOOLS));
    expect(rendered).toBe(readFileSync(GENERATED_PATH, 'utf8'));
  });

  it('is what tools/list serves', () => {
    for (const tool of renderSurface(undefined).tools) {
      expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name]);
    }
  });

  it('names every method signature exactly once', () => {
    for (const method of METHODS) {
      const description = TOOL_DESCRIPTIONS[method.tool]!;
      expect(description).toContain(method.signature);
    }
  });

  it('groups the signatures by effect, reads before writes', () => {
    const firestore = TOOL_DESCRIPTIONS.firestore!;
    expect(firestore.indexOf('Read methods:')).toBeLessThan(firestore.indexOf('Write methods:'));
    const sandbox = TOOL_DESCRIPTIONS.sandbox!;
    expect(sandbox).toContain('Destructive methods, which require confirm: true');
    expect(sandbox.indexOf('Write methods:')).toBeLessThan(
      sandbox.indexOf('Destructive methods'),
    );
  });

  it('points every tool at describe for the full schema', () => {
    for (const description of Object.values(TOOL_DESCRIPTIONS)) {
      expect(description).toContain("Call method 'describe' with args { method }");
    }
  });

  it('says the branch methods carry Firestore documents and nothing else', () => {
    // A branch holds Firestore documents. Storage objects, auth users, and the
    // rules the live sandbox runs under are not branched, so a description that
    // said "the sandbox" would promise a fork the engine does not take.
    for (const name of ['fork', 'apply', 'diff', 'promote', 'discard']) {
      const record = METHODS.find((method) => method.key === `sandbox.${name}`);
      expect(record).toBeDefined();
      expect(record!.description).toContain('Firestore');
    }
  });

  it('keeps every description inside the character limit', () => {
    for (const description of Object.values(TOOL_DESCRIPTIONS)) {
      expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    }
  });

  it('keeps the whole listing inside the token budget', () => {
    const listing = renderSurface(undefined).tools
      .map((tool) => `${tool.name}${tool.description}${JSON.stringify(tool.inputSchema)}`)
      .join('');
    expect(listing.length / CHARACTERS_PER_TOKEN).toBeLessThan(LISTING_TOKEN_BUDGET);
  });
});
