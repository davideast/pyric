/**
 * The pre-flight artifact scan's pure half: which dirs are worth looking in,
 * and how a finding reads.
 */
import { describe, expect, it } from 'bun:test';
import {
  BACKEND_ARTIFACT_DIRS,
  formatInlinedArtifactWarnings,
} from '../../src/cli/sandbox-preflight.js';

describe('BACKEND_ARTIFACT_DIRS', () => {
  it('covers the backend build outputs a launched child would actually load', () => {
    expect([...BACKEND_ARTIFACT_DIRS].sort()).toEqual(
      ['.next/server', 'build', 'dist', 'functions'].sort(),
    );
  });
});

describe('formatInlinedArtifactWarnings', () => {
  it('is empty for a clean scan', () => {
    expect(formatInlinedArtifactWarnings([])).toEqual([]);
  });

  it('names the file, the catalog service and the host, one line per file', () => {
    const lines = formatInlinedArtifactWarnings([
      { file: '.next/server/chunk.js', host: 'firestore.googleapis.com', service: 'Cloud Firestore' },
      {
        file: 'dist/server.cjs',
        host: 'identitytoolkit.googleapis.com',
        service: 'Firebase Authentication',
      },
    ]);
    expect(lines[0]).toContain('⚠ preflight');
    expect(lines[0]).toContain('.next/server/chunk.js');
    expect(lines[0]).toContain('Cloud Firestore');
    expect(lines[0]).toContain('firestore.googleapis.com');
    expect(lines[1]).toContain('dist/server.cjs');
    expect(lines[1]).toContain('Firebase Authentication');
    // A trailing line explains what a finding means and that nothing was blocked.
    const summary = lines[lines.length - 1]!;
    expect(summary).toContain('2 build artifacts');
    expect(summary.toLowerCase()).toContain('module swap');
    expect(summary).toContain('LIVE Firebase');
    expect(summary.toLowerCase()).toContain('external');
    expect(summary.toLowerCase()).toContain('warning only');
  });

  it('caps the per-file lines so a badly built project cannot flood the console', () => {
    const hits = Array.from({ length: 40 }, (_, i) => ({
      file: `dist/chunk-${i}.js`,
      host: 'firestore.googleapis.com',
      service: 'Cloud Firestore',
    }));
    const lines = formatInlinedArtifactWarnings(hits);
    expect(lines.length).toBeLessThan(15);
    expect(lines.some((l) => l.includes('more'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('40 build artifacts');
  });
});
