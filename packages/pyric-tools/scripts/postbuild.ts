#!/usr/bin/env bun
/**
 * Post-build: chmod the `pyric` bin so `npx pyric` works after install.
 * Shebang is preserved by tsc from src/cli/index.ts.
 */
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(__dirname);
const BIN = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

if (!existsSync(BIN)) {
  console.error(`expected ${BIN} after tsc build`);
  process.exit(1);
}

chmodSync(BIN, 0o755);
console.log(`chmod +x dist/cli/index.js`);
