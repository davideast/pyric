import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveViteRulesConfig } from '../../src/serve/vite-rules-source.js';

function project(): string {
  return mkdtempSync(path.join(tmpdir(), 'pyric-vite-rules-source-'));
}

describe('Vite rules source convention', () => {
  it('gives an explicit rules path precedence over the modules convention', () => {
    const root = project();
    writeFileSync(path.join(root, 'firestore.modules.rules'), 'modules');
    expect(resolveViteRulesConfig(root, 'custom.rules', {
      firestore: { rules: 'firebase.rules' },
    })).toEqual({ firestore: { rules: 'custom.rules' } });
  });

  it('prefers firestore.modules.rules over firebase.json', () => {
    const root = project();
    writeFileSync(path.join(root, 'firestore.modules.rules'), 'modules');
    expect(resolveViteRulesConfig(root, undefined, {
      firestore: { rules: 'firebase.rules' },
      storage: { rules: 'storage.rules' },
    })).toEqual({
      firestore: { rules: 'firestore.modules.rules' },
      storage: { rules: 'storage.rules' },
    });
  });

  it('prefers storage.modules.rules for Vite while preserving the deployment target', () => {
    const root = project();
    writeFileSync(path.join(root, 'storage.modules.rules'), 'modules');
    expect(resolveViteRulesConfig(root, undefined, {
      firestore: { rules: 'firestore.rules' },
      storage: { rules: 'storage.rules', bucket: 'assets.example' },
    })).toEqual({
      firestore: { rules: 'firestore.rules' },
      storage: {
        rules: 'storage.modules.rules',
        bucket: 'assets.example',
      },
    });
  });

  it('updates the first configured Storage rules entry for Vite', () => {
    const root = project();
    writeFileSync(path.join(root, 'storage.modules.rules'), 'modules');
    expect(resolveViteRulesConfig(root, undefined, {
      storage: [
        { bucket: 'one.example' },
        { rules: 'storage.rules', bucket: 'two.example' },
      ],
    })).toEqual({
      storage: [
        { bucket: 'one.example' },
        { rules: 'storage.modules.rules', bucket: 'two.example' },
      ],
    });
  });

  it('preserves firebase.json when no explicit or modules source exists', () => {
    const root = project();
    const firebase = { firestore: { rules: 'firestore.rules' } };
    expect(resolveViteRulesConfig(root, undefined, firebase)).toBe(firebase);
  });

  it('leaves discovery open for the firestore.rules fallback', () => {
    const root = project();
    writeFileSync(path.join(root, 'firestore.rules'), 'fallback');
    expect(resolveViteRulesConfig(root, undefined, null)).toBeNull();
  });
});
