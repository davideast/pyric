/**
 * The inlined-SDK artifact scanner.
 *
 * Two callers pass two different host sets, so every test here says which one
 * it is asking about: `SDK_FINGERPRINT_HOSTS` is what the throwing frontend
 * build check greps for, `GOOGLE_ENDPOINT_HOSTS` is what the warn-only
 * pre-flight scan greps for.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInlinedFirebaseHits } from '../../src/cli/inlined-sdk-scanner.js';
import { GOOGLE_ENDPOINT_HOSTS, SDK_FINGERPRINT_HOSTS } from '../../src/google-endpoints.js';

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `pyric-inline-${label}-`));
}

/** Paths only, the shape most assertions here care about. */
function scanPaths(root: string, hosts: readonly string[], dirs?: readonly string[]): string[] {
  const opts = dirs === undefined ? { hosts } : { hosts, dirs };
  return scanInlinedFirebaseHits(root, opts).map((hit) => hit.file);
}

describe('scanInlinedFirebaseHits over a served frontend', () => {
  it('flags a bundled chunk that inlines real-SDK endpoint hosts', () => {
    const dir = scratch('scan');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'assets', 'index-abc.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    expect(scanPaths(dir, SDK_FINGERPRINT_HOSTS)).toEqual(['assets/index-abc.js']);
  });

  it('stays clean for an unbundled app importing firebase by bare specifier', () => {
    const dir = scratch('clean');
    writeFileSync(
      join(dir, 'main.js'),
      "import { getAuth } from 'firebase/auth'; import { getFirestore } from 'firebase/firestore';",
    );
    expect(scanPaths(dir, SDK_FINGERPRINT_HOSTS)).toEqual([]);
  });

  it('ignores hidden framework and build cache directories like .next and .git', () => {
    const dir = scratch('ignore');
    mkdirSync(join(dir, '.next'));
    writeFileSync(
      join(dir, '.next', 'bundle.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    expect(scanPaths(dir, SDK_FINGERPRINT_HOSTS)).toEqual([]);
  });

  it('flags inlined Installations, FCM registration and Firebase AI Logic hosts', () => {
    const cases: Array<[string, string]> = [
      ['inst.js', 'fetch("https://firebaseinstallations.googleapis.com/v1/projects/x/installations")'],
      ['fcm.js', 'fetch("https://fcmregistrations.googleapis.com/v1/projects/x/registrations")'],
      ['ai.js', 'fetch("https://firebasevertexai.googleapis.com/v1beta/projects/x")'],
      ['rtdb.js', 'new WebSocket("wss://demo.firebasedatabase.app/.ws?v=5")'],
    ];
    for (const [name, body] of cases) {
      const dir = scratch('hosts');
      writeFileSync(join(dir, name), body);
      expect(scanPaths(dir, SDK_FINGERPRINT_HOSTS)).toEqual([name]);
    }
  });

  it('scans .cjs bundles, which is what a CommonJS backend build emits', () => {
    const dir = scratch('cjs');
    writeFileSync(
      join(dir, 'server.cjs'),
      'fetch("https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents")',
    );
    expect(scanPaths(dir, SDK_FINGERPRINT_HOSTS)).toEqual(['server.cjs']);
  });
});

describe('scanInlinedFirebaseHits over explicit backend dirs', () => {
  it('scans the named dirs, including dot-dirs like .next/server', () => {
    const root = scratch('backend');
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, '.next', 'server'), { recursive: true });
    mkdirSync(join(root, 'functions'));
    writeFileSync(
      join(root, 'dist', 'server.cjs'),
      'require("node-fetch")("https://identitytoolkit.googleapis.com/v1/accounts:signUp")',
    );
    writeFileSync(
      join(root, '.next', 'server', 'chunk.js'),
      'fetch("https://firestore.googleapis.com/v1/projects")',
    );
    writeFileSync(join(root, 'functions', 'index.js'), 'exports.hi = () => "clean";');
    const hits = scanPaths(root, GOOGLE_ENDPOINT_HOSTS, [
      'dist',
      '.next/server',
      'functions',
      'does-not-exist',
    ]);
    expect(hits.sort()).toEqual(['.next/server/chunk.js', 'dist/server.cjs']);
  });

  it('leaves the root-only walk unchanged when no dirs are given', () => {
    const root = scratch('default');
    mkdirSync(join(root, '.next', 'server'), { recursive: true });
    writeFileSync(
      join(root, '.next', 'server', 'chunk.js'),
      'fetch("https://firestore.googleapis.com/v1/projects")',
    );
    writeFileSync(join(root, 'index.js'), "import { getAuth } from 'firebase/auth';");
    expect(scanPaths(root, GOOGLE_ENDPOINT_HOSTS)).toEqual([]);
  });

  it('reports which host and service each hit matched', () => {
    const root = scratch('detail');
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      join(root, 'dist', 'server.cjs'),
      'fetch("https://identitytoolkit.googleapis.com/v1/accounts:signUp")',
    );
    expect(scanInlinedFirebaseHits(root, { hosts: GOOGLE_ENDPOINT_HOSTS, dirs: ['dist'] })).toEqual([
      {
        file: 'dist/server.cjs',
        host: 'identitytoolkit.googleapis.com',
        service: 'Firebase Authentication',
      },
    ]);
  });

  it('reports non-fingerprint hosts to the pre-flight scan and not to the build check', () => {
    const root = scratch('preflight-only');
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      join(root, 'dist', 'callable.js'),
      'fetch(`https://us-central1-${p}.cloudfunctions.net/callMe`)',
    );
    expect(scanPaths(root, GOOGLE_ENDPOINT_HOSTS, ['dist'])).toEqual(['dist/callable.js']);
    expect(scanPaths(root, SDK_FINGERPRINT_HOSTS, ['dist'])).toEqual([]);
  });
});
