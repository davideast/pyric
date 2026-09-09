/**
 * The rules text Studio's inspectors display: the compiler's source-map
 * trailer is machine output, so it is cut before the text reaches a reader.
 */
import { describe, it, expect } from 'bun:test';

import { stripPyricSourceMap } from '../../src/shell/studio-rules-source.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read: if true; }
  }
}`;

describe('stripPyricSourceMap', () => {
  it('returns a source carrying no marker unchanged, byte for byte', () => {
    expect(stripPyricSourceMap(RULES)).toBe(RULES);
  });

  it('cuts the marker and everything after it', () => {
    const compiled = `${RULES}\n\n// @pyric-source-map: {"sources":["rules/main.rules"]}\n`;
    expect(stripPyricSourceMap(compiled)).toBe(RULES);
  });

  it('cuts at the first marker when the trailer carries more than one line', () => {
    const compiled = `${RULES}\n// @pyric-source-map: a\n// @pyric-source-map: b\n`;
    expect(stripPyricSourceMap(compiled)).toBe(RULES);
  });

  it('answers the empty source with the empty source', () => {
    expect(stripPyricSourceMap('')).toBe('');
  });
});
