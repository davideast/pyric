import { beforeAll, describe, expect, it } from 'bun:test';
import type { CompatibilitySurfaceRegistry } from '../../registry/types.ts';
import { deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';
import {
  generatedRowLineNumbers,
  renderSurfaceMarkdown,
  type DocumentationProjection,
} from '../../src/generate-docs.ts';

let model: ConformanceModel;
let projection: DocumentationProjection;
beforeAll(async () => {
  model = await deriveConformanceModel();
  projection = model.documentation;
}, 60_000);

/** The rendered table row for a registry row ends with its `rowRef` cell —
 * a per-surface-unique marker. If a stored line number resolves to a line
 * ending in this cell, the ledger points at the right row. */
function rowRefCell(rowRef: string): string {
  return `| ${rowRef.replace(/\|/g, '\\|')} |`;
}

/** A surface with at least one table block, for the drift scenarios. */
function firstTableSurface(): CompatibilitySurfaceRegistry {
  const surface = projection.registries.find((s) => s.blocks.some((b) => b.kind === 'table'));
  if (!surface) throw new Error('expected at least one surface with a table block');
  return surface;
}

describe('generatedRowLineNumbers ↔ rendered projection coupling', () => {
  it('every keyed row identity resolves to its own rendered table row', () => {
    for (const surface of projection.registries) {
      const lines = renderSurfaceMarkdown(surface, projection).split('\n');
      const rowLines = generatedRowLineNumbers(surface, projection);
      const tableRows = surface.blocks.flatMap((b) => (b.kind === 'table' ? b.rows : []));
      for (const row of tableRows) {
        const line = rowLines.get(row.id);
        expect(line, `no line number keyed for ${row.id}`).toBeDefined();
        const rendered = lines[line! - 1];
        expect(rendered, `line ${line} out of range for ${row.id}`).toBeDefined();
        // Resolves to a markdown table data row, and to the right one.
        expect(rendered!.startsWith('| ')).toBe(true);
        expect(rendered!.endsWith(rowRefCell(row.rowRef))).toBe(true);
      }
    }
  });

  it('line numbers are derived from the same pass as the markdown (no parallel render)', () => {
    // Line count of the index must never exceed the rendered line count: a
    // divergent second render loop is exactly how the two drift apart.
    for (const surface of projection.registries) {
      const lineCount = renderSurfaceMarkdown(surface, projection).split('\n').length;
      for (const [id, line] of generatedRowLineNumbers(surface, projection)) {
        expect(line, `${id} points past end of rendered page`).toBeLessThanOrEqual(lineCount);
        expect(line).toBeGreaterThan(0);
      }
    }
  });

  it('survives a renderer change: an extra line before the rows shifts references in lockstep', () => {
    const surface = firstTableSurface();
    // Simulate a renderer/content edit — a new heading, legend row, or blank
    // line inserted ahead of the table. A stored-line-number scheme would now
    // point one row too high; because both the markdown and the line index are
    // produced by one pass, every identity must still resolve to its own row.
    const shifted: CompatibilitySurfaceRegistry = {
      ...surface,
      blocks: [{ kind: 'markdown', markdown: 'Inserted renderer note (drift probe).' }, ...surface.blocks],
    };

    const baseline = generatedRowLineNumbers(surface, projection);
    const afterEdit = generatedRowLineNumbers(shifted, projection);
    const lines = renderSurfaceMarkdown(shifted, projection).split('\n');
    const tableRows = shifted.blocks.flatMap((b) => (b.kind === 'table' ? b.rows : []));

    let anyShifted = false;
    for (const row of tableRows) {
      const before = baseline.get(row.id);
      const after = afterEdit.get(row.id);
      expect(after, `identity ${row.id} lost after renderer change`).toBeDefined();
      // The reference still resolves to this row's own rendered line...
      expect(lines[after! - 1]!.endsWith(rowRefCell(row.rowRef))).toBe(true);
      // ...at a moved coordinate, proving the derivation tracked the change.
      if (before !== undefined && after! !== before) anyShifted = true;
    }
    expect(anyShifted, 'inserting a line should move the derived line numbers').toBe(true);
  });
});
