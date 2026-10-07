import { describe, test, expect } from 'bun:test';
import { resolveModules } from '../../../src/rules/modules/resolver.js';
import { readAuthoredSourceMap } from '../../../src/rules/modules/resolver-core.js';

const moduleSource = 'export function check() { let ok = request.auth != null; return ok; }';

const roots: Array<[string, string]> = [
  [
    'firestore.modules.rules',
    `rules_version = '2+modules';
import { check } from './m';
service cloud.firestore {
  match /databases/{database}/documents {
    function own() {
      let uid = request.auth.uid;
      return uid == resource.data.owner;
    }
    match /games/{id} { allow update: if own() && check(); }
  }
}`,
  ],
  [
    'storage.modules.rules',
    `rules_version = '2+modules';
import { check } from './m';
service firebase.storage {
  match /b/{bucket}/o {
    function own() {
      let uid = request.auth.uid;
      return uid == resource.metadata.owner;
    }
    match /games/{id} { allow write: if own() && check(); }
  }
}`,
  ],
];

describe('resolved source map names the file each generated line came from', () => {
  for (const [file, source] of roots) {
    test(`${file}: service header and let lines name the root file`, () => {
      const r = resolveModules(source, { sourceFile: file, modules: { './m': moduleSource } });
      expect(r.success).toBe(true);
      if (!r.success) return;
      const lines = r.data.resolved.split('\n');
      const map = readAuthoredSourceMap(r.data.resolved);
      const rootLines = [...map.values()].filter((e) => e.authoredFile === file);
      const texts = rootLines.map((e) => lines[e.generatedLine - 1]!.trim());
      expect(texts.some((t) => t.startsWith('service '))).toBe(true);
      expect(texts.some((t) => t.startsWith('let uid'))).toBe(true);
      for (const entry of map.values()) {
        const text = lines[entry.generatedLine - 1]!.trim();
        if (/^(let ok|function check)/.test(text)) continue;
        expect({ text, file: entry.authoredFile }).toEqual({ text, file });
      }
    });
  }
});
