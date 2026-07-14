#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_RUNTIMES = new Set([
  '@huggingface/transformers',
  'onnxruntime-node',
]);

export function inspectCloudOnlyDependencyTree(tree, status) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
    throw new Error('npm dependency inspection returned a malformed tree');
  }

  if (status !== 0) {
    throw new Error(`npm dependency inspection exited with unexpected status ${status}`);
  }

  const failOnReportedError = (node) => {
    if (!node.error) return;
    const code = typeof node.error === 'object' ? node.error.code : undefined;
    const summary = typeof node.error === 'object' ? node.error.summary : String(node.error);
    const label = code ? ` (${code})` : '';
    const detail = summary ? `: ${summary}` : '';
    throw new Error(`npm dependency inspection failed${label}${detail}`);
  };

  const found = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    failOnReportedError(node);
    if (node.problems !== undefined) {
      if (!Array.isArray(node.problems)) {
        throw new Error('npm dependency inspection returned malformed problems');
      }
      if (node.problems.length) {
        throw new Error(`npm dependency inspection reported problems: ${node.problems.join('; ')}`);
      }
    }
    if (
      node.dependencies !== undefined &&
      (!node.dependencies || typeof node.dependencies !== 'object' || Array.isArray(node.dependencies))
    ) {
      throw new Error('npm dependency inspection returned malformed dependencies');
    }
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (FORBIDDEN_RUNTIMES.has(name)) {
        if (child && typeof child === 'object' && typeof child.version === 'string') {
          found.add(name);
        } else if (!child || typeof child !== 'object' || Object.keys(child).length !== 0) {
          throw new Error(`npm dependency inspection returned malformed node for ${name}`);
        }
        // npm represents an absent optional peer as an empty object. An installed
        // package always carries its resolved version in the complete tree.
      }
      visit(child);
    }
  };
  visit(tree);
  return [...found].sort();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const tree = JSON.parse(readFileSync(0, 'utf8'));
    const status = Number(process.argv[2]);
    const found = inspectCloudOnlyDependencyTree(tree, status);
    if (found.length) {
      console.error(`  ✗ cloud-only install acquired: ${found.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('  ✓ neither @huggingface/transformers nor onnxruntime-node is installed');
    }
  } catch (error) {
    console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
