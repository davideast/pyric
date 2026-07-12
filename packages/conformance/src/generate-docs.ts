#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow, type CompatibilitySurfaceRegistry, type CompatStatus } from '../registry/index.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..');
export const GENERATED_HEADER = '<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->';

/** Display glyphs for the typed status enum — rendering only, never parsed. */
export const STATUS_GLYPHS: Record<CompatStatus, string> = {
  'conforms': '✓',
  'diverged-documented': '⚠',
  'bug': '✗',
  'unsupported': '—',
  'unverified': '?',
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function renderStatus(row: CompatibilityRow): string {
  const glyph = STATUS_GLYPHS[row.status];
  return row.statusNote ? `${glyph} ${row.statusNote}` : glyph;
}

function renderRow(row: CompatibilityRow): string {
  return `| ${escapeCell(row.rowRef)} | ${escapeCell(row.behavior)} | ${escapeCell(renderStatus(row))} | ${escapeCell(row.evidence)} |`;
}

/** Non-conforming statuses, in the order the climb header lists them. */
const CLIMB_STATUS_ORDER: CompatStatus[] = ['unverified', 'diverged-documented', 'bug', 'unsupported'];

/**
 * The climb header for a surface admitted under CDD (cdd.md Step 7): rendered
 * above the status legend, derived from the registry's row statuses alone. A
 * non-climbing surface returns no lines, so its doc is byte-for-byte unchanged.
 * Kept identical between renderSurfaceMarkdown and generatedRowLineNumbers so
 * row line numbers stay accurate.
 */
export function climbHeaderLines(surface: CompatibilitySurfaceRegistry): string[] {
  const climbing = surfaceDescriptors.some((d) => d.registry === surface && d.climb === true);
  if (!climbing) return [];
  const rows = surface.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
  const conforming = rows.filter((row) => row.status === 'conforms').length;
  const breakdown = CLIMB_STATUS_ORDER.map((status) => ({ status, count: rows.filter((row) => row.status === status).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status}`)
    .join(', ');
  return [
    '> **Climb status: this surface is climbing under CDD.**',
    `> ${conforming} of ${rows.length} rows conforming.${breakdown ? ` ${breakdown}.` : ''}`,
    '> A `?` row below is a target with a derived failing test, not a guarantee.',
    '',
  ];
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry): string {
  const parts: string[] = [GENERATED_HEADER, '', ...climbHeaderLines(surface)];
  for (const [index, block] of surface.blocks.entries()) {
    if (block.kind === 'markdown') {
      parts.push(block.markdown);
      continue;
    }
    parts.push(block.prefix);
    parts.push('| # | Behavior | Status | Probe |');
    parts.push('|---|---|---|---|');
    for (const row of block.rows) parts.push(renderRow(row));
    const next = surface.blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) parts.push('');
  }
  return parts.join('\n').replace(/\s+$/, '') + '\n';
}

export function generatedRowLineNumbers(surface: CompatibilitySurfaceRegistry): Map<string, number> {
  const lines: string[] = [GENERATED_HEADER, '', ...climbHeaderLines(surface)];
  const out = new Map<string, number>();
  for (const [index, block] of surface.blocks.entries()) {
    if (block.kind === 'markdown') {
      const markdown = block.markdown;
      if (markdown) lines.push(...markdown.split('\n'));
      continue;
    }
    const prefix = block.prefix;
    if (prefix) lines.push(...prefix.split('\n'));
    lines.push('| # | Behavior | Status | Probe |');
    lines.push('|---|---|---|---|');
    for (const row of block.rows) {
      lines.push(renderRow(row));
      out.set(row.id, lines.length);
    }
    const next = surface.blocks[index + 1];
    if (next?.kind === 'table' || (next?.kind === 'markdown' && !next.markdown.startsWith('\n'))) lines.push('');
  }
  return out;
}

export function renderAllCompatibilityMarkdown(): Map<string, string> {
  return new Map(surfaceRegistries.map((surface) => [surface.compatPath, renderSurfaceMarkdown(surface)]));
}

export function checkGeneratedMarkdown(): string[] {
  const problems: string[] = [];
  for (const [rel, generated] of renderAllCompatibilityMarkdown()) {
    const path = join(REPO_ROOT, rel);
    const current = readFileSync(path, 'utf8');
    if (current !== generated) problems.push(`${rel}: does not match registry-generated output`);
  }
  return problems;
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  if (write) {
    for (const [rel, generated] of renderAllCompatibilityMarkdown()) writeFileSync(join(REPO_ROOT, rel), generated);
    console.log(`Generated ${surfaceRegistries.length} compatibility document(s).`);
  }
  if (check) {
    const problems = checkGeneratedMarkdown();
    if (problems.length > 0) {
      for (const problem of problems) console.error(`- ${problem}`);
      process.exit(1);
    }
    console.log('Compatibility markdown is generated from the registry.');
  }
}
