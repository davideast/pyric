/**
 * The inlined-SDK scanner behind the throwing frontend build check.
 *
 * It walks one served directory and matches `SDK_FINGERPRINT_HOSTS`, the
 * narrow subset that only appears when real SDK code was compiled in. The
 * cases below pin both halves: what a served dist must be flagged for, and
 * what it must never be flagged for, since a hit fails the build.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForInlinedFirebase } from '../../src/cli/inlined-sdk-scanner.js';

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `pyric-inline-${label}-`));
}

describe('scanForInlinedFirebase', () => {
  it('flags a bundled chunk that inlines real-SDK endpoint hosts', () => {
    const dir = scratch('scan');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'assets', 'index-abc.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    expect(scanForInlinedFirebase(dir)).toEqual(['assets/index-abc.js']);
  });

  it('flags every other fingerprint host too', () => {
    const cases: Array<[string, string]> = [
      ['token.js', 'fetch("https://securetoken.googleapis.com/v1/token")'],
      ['fs.js', 'fetch("https://firestore.googleapis.com/v1/projects")'],
      ['inst.js', 'fetch("https://firebaseinstallations.googleapis.com/v1/projects/x")'],
      ['fcm.js', 'fetch("https://fcmregistrations.googleapis.com/v1/projects/x/registrations")'],
      ['ai.js', 'fetch("https://firebasevertexai.googleapis.com/v1beta/projects/x")'],
      ['rtdb.js', 'new WebSocket("wss://demo.firebasedatabase.app/.ws?v=5")'],
    ];
    for (const [name, body] of cases) {
      const dir = scratch('hosts');
      writeFileSync(join(dir, name), body);
      expect(scanForInlinedFirebase(dir)).toEqual([name]);
    }
  });

  it('stays clean for an unbundled app importing firebase by bare specifier', () => {
    const dir = scratch('clean');
    writeFileSync(
      join(dir, 'main.js'),
      "import { getAuth } from 'firebase/auth'; import { getFirestore } from 'firebase/firestore';",
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });

  it('never fails a build over a host an ordinary app can carry without an SDK', () => {
    const cases: Array<[string, string]> = [
      ['asset.js', 'const logo = "https://storage.googleapis.com/my-bucket/logo.png";'],
      ['dl.js', 'const u = "https://firebasestorage.googleapis.com/v0/b/x/o/y";'],
      ['fn.js', 'fetch(`https://us-central1-${p}.cloudfunctions.net/callMe`)'],
      ['cfg.js', 'const databaseURL = "https://demo.firebaseio.com";'],
      ['vertex.js', 'fetch("https://aiplatform.googleapis.com/v1/publishers/google/models")'],
      ['meta.js', 'fetch("http://169.254.169.254/computeMetadata/v1/token")'],
    ];
    for (const [name, body] of cases) {
      const dir = scratch('nonfingerprint');
      writeFileSync(join(dir, name), body);
      expect(scanForInlinedFirebase(dir)).toEqual([]);
    }
  });

  it('ignores hidden framework and build cache directories like .next and .git', () => {
    const dir = scratch('ignore');
    mkdirSync(join(dir, '.next'));
    writeFileSync(
      join(dir, '.next', 'bundle.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });

  it('ignores a node_modules inside the served directory', () => {
    const dir = scratch('nodemodules');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(
      join(dir, 'node_modules', 'dep.js'),
      'fetch("https://firestore.googleapis.com/v1/projects")',
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });

  it('reads only served script extensions', () => {
    const dir = scratch('ext');
    const body = 'fetch("https://firestore.googleapis.com/v1/projects")';
    writeFileSync(join(dir, 'app.mjs'), body);
    writeFileSync(join(dir, 'notes.txt'), body);
    writeFileSync(join(dir, 'server.cjs'), body);
    expect(scanForInlinedFirebase(dir)).toEqual(['app.mjs']);
  });
});
