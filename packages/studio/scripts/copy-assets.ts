import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const source = join(root, 'src');
const output = join(root, 'dist');

function copyCss(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyCss(path);
    } else if (entry.name.endsWith('.css')) {
      const target = join(output, relative(source, path));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target);
    }
  }
}

copyCss(source);
