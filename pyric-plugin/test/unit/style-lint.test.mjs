import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const stagesDir = path.resolve(__dirname, '../../skills/improve-firebase/assets/stages');

const ALLOWED_COLORS = [
  '#212121', '#2a2a2a', '#1e1e1e', '#121212', '#333333', '#000', '#fff',
  '#f5f5f5', '#b3b3b3', '#d4d4d4', '#a3a3a3', '#fafafa',
  'transparent', 'inherit', 'currentColor',
  'var(--surface)', 'var(--panel)', 'var(--ink)', 'var(--muted)', 'var(--accent)', 'var(--danger)', 'var(--success)', 'var(--border)'
];

const RGBA_REGEX = /rgba\(\s*(255|0)\s*,\s*(255|0)\s*,\s*(255|0)\s*,\s*[0-9.]+\s*\)/;
const COLOR_PROP_REGEX = /(?:color|background|background-color|border-color|fill|stroke)\s*:\s*([^;!}]+)/g;

test('Style-rules lint over stage HTML/CSS', async (t) => {
  const files = fs.readdirSync(stagesDir).filter(f => f.endsWith('.html'));
  for (const f of files) {
    const content = fs.readFileSync(path.join(stagesDir, f), 'utf8');

    // 1. no border-left accent declarations
    // hairline `border-left: 0`/`none` is fine
    // look for `border-left: ` followed by something other than 0 or none
    const borderLeftLines = content.split('\n').filter(l => l.includes('border-left:'));
    for (const line of borderLeftLines) {
      if (!line.includes('border-left: 0') && !line.includes('border-left: none')) {
        assert.fail(`File ${f} has colored left border: ${line.trim()}`);
      }
    }

    // 2. no middots or bullets
    if (content.includes('·') || content.includes('•')) {
      assert.fail(`File ${f} contains forbidden middot/bullet characters`);
    }

    // 3. palette check
    let match;
    while ((match = COLOR_PROP_REGEX.exec(content)) !== null) {
      const val = match[1].trim();
      // Ignore gradients for a moment if they just contain rgba
      const parts = val.split(/[\s,()]+/);
      for (const p of parts) {
        if (p.startsWith('#')) {
          if (!ALLOWED_COLORS.includes(p.toLowerCase())) {
            assert.fail(`File ${f} has non-gray color literal: ${p}`);
          }
        }
      }
      
      // Check rgba
      const rgbaMatches = val.match(/rgba\([^)]+\)/g);
      if (rgbaMatches) {
        for (const rgba of rgbaMatches) {
          if (!RGBA_REGEX.test(rgba)) {
            assert.fail(`File ${f} has non-gray rgba color: ${rgba}`);
          }
        }
      }
    }
  }
});
