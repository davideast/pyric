#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow, type CompatibilitySurfaceRegistry } from './registry/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const GENERATED_HEADER = '<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function renderRow(row: CompatibilityRow): string {
  return `| ${escapeCell(row.rowRef)} | ${escapeCell(row.behavior)} | ${escapeCell(row.status)} | ${escapeCell(row.evidence)} |`;
}

export function renderSurfaceMarkdown(surface: CompatibilitySurfaceRegistry): string {
  const parts: string[] = [GENERATED_HEADER, ''];
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
  const lines: string[] = [GENERATED_HEADER, ''];
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
