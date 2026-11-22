/**
 * The inlined-SDK scanner behind the throwing frontend build check.
 *
 * It walks one served directory and matches `SDK_FINGERPRINT_HOSTS`, the
 * narrow subset that only appears when real SDK code was compiled in. The
 * cases below pin what a served dist must be flagged for, what it must never
 * be flagged for, and when early-stop limit warnings fire (#1629).
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanForInlinedFirebase } from '../../src/cli/inlined-sdk-scanner.js';
import { useTempDirs } from '../use-temp-dirs.js';

const scratch = useTempDirs('pyric-inline-');

describe('scanForInlinedFirebase', () => {
  it('flags a bundled chunk that inlines real-SDK endpoint hosts', () => {
    const dir = scratch('pyric-inline-scan-');
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
      const dir = scratch('pyric-inline-hosts-');
      writeFileSync(join(dir, name), body);
      expect(scanForInlinedFirebase(dir)).toEqual([name]);
    }
  });

  it('stays clean for an unbundled app importing firebase by bare specifier', () => {
    const dir = scratch('pyric-inline-clean-');
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
      const dir = scratch('pyric-inline-nonfingerprint-');
      writeFileSync(join(dir, name), body);
      expect(scanForInlinedFirebase(dir)).toEqual([]);
    }
  });

  it('ignores hidden framework and build cache directories like .next and .git', () => {
    const dir = scratch('pyric-inline-ignore-');
    mkdirSync(join(dir, '.next'));
    writeFileSync(
      join(dir, '.next', 'bundle.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/projects?key="+k)',
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });

  it('ignores a node_modules inside the served directory', () => {
    const dir = scratch('pyric-inline-nodemodules-');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(
      join(dir, 'node_modules', 'dep.js'),
      'fetch("https://firestore.googleapis.com/v1/projects")',
    );
    expect(scanForInlinedFirebase(dir)).toEqual([]);
  });

  it('reads only served script extensions and inline HTML scripts', () => {
    const dir = scratch('pyric-inline-ext-');
    const body = 'fetch("https://firestore.googleapis.com/v1/projects")';
    writeFileSync(join(dir, 'app.mjs'), body);
    writeFileSync(join(dir, 'notes.txt'), body);
    writeFileSync(join(dir, 'server.cjs'), body);
    expect(scanForInlinedFirebase(dir)).toEqual(['app.mjs']);
  });

  it('flags inline <script> blocks in .html and .htm files while ignoring prose, external src, and JSON scripts (#1629)', () => {
    const flagged = scratch('pyric-inline-html-hit-');
    writeFileSync(
      join(flagged, 'index.html'),
      '<!doctype html><html><body><script type="module">const DEFAULT_HOST="firestore.googleapis.com";</script></body></html>',
    );
    writeFileSync(
      join(flagged, 'legacy.htm'),
      '<script>fetch("https://identitytoolkit.googleapis.com/v1/accounts")</script>',
    );
    writeFileSync(
      join(flagged, 'data-attrs.html'),
      '<script data-src="/noop.js" data-type="application/json" data-note="src=/x.js type=application/json">const DEFAULT_HOST="firestore.googleapis.com";</script>',
    );
    expect(scanForInlinedFirebase(flagged)).toEqual([
      'data-attrs.html',
      'index.html',
      'legacy.htm',
    ]);

    const clean = scratch('pyric-inline-html-clean-');
    writeFileSync(
      join(clean, 'index.html'),
      [
        '<!doctype html><html><body>',
        '<p>Docs mention https://firestore.googleapis.com/v1/projects in prose.</p>',
        '<script type="importmap">{"imports":{"firebase/firestore":"/__pyric/sdk/firestore.js"}}</script>',
        '<script type="application/json">{"endpoint":"firestore.googleapis.com"}</script>',
        '<script src="/bundle.js">const ignoredBecauseExternal="firestore.googleapis.com";</script>',
        '<script type="module">import { getFirestore } from "firebase/firestore";</script>',
        '</body></html>',
      ].join('\n'),
    );
    expect(scanForInlinedFirebase(clean)).toEqual([]);
  });

  it('scans past 200 files and 4 directory levels by default (#1629)', () => {
    const manyFiles = scratch('pyric-inline-260-');
    const assets = join(manyFiles, 'assets');
    mkdirSync(assets, { recursive: true });
    for (let i = 0; i < 259; i += 1) {
      writeFileSync(join(assets, `chunk-${String(i).padStart(4, '0')}.js`), 'export const ok = 1;');
    }
    writeFileSync(join(assets, 'zzzz-sdk.js'), 'const DEFAULT_HOST="firestore.googleapis.com";');
    const fsOrder = readdirSync(assets);
    expect(fsOrder.length).toBe(260);
    const warningsMany: string[] = [];
    expect(scanForInlinedFirebase(manyFiles, { onWarning: (w) => warningsMany.push(w) })).toEqual([
      'assets/zzzz-sdk.js',
    ]);
    expect(warningsMany).toEqual([]);

    const deepDir = scratch('pyric-inline-depth6-');
    const routeDir = join(deepDir, '_next', 'static', 'chunks', 'app', 'blog', '[slug]');
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(join(routeDir, 'page.js'), 'const DEFAULT_HOST="firestore.googleapis.com";');
    const warningsDeep: string[] = [];
    expect(scanForInlinedFirebase(deepDir, { onWarning: (w) => warningsDeep.push(w) })).toEqual([
      '_next/static/chunks/app/blog/[slug]/page.js',
    ]);
    expect(warningsDeep).toEqual([]);
  });

  it('warns when stopping early at maxFiles or maxDepth and stays silent when limits are not exceeded (#1629)', () => {
    const exactLimit = scratch('pyric-inline-exact-');
    writeFileSync(join(exactLimit, 'a.js'), 'export const a = 1;');
    writeFileSync(join(exactLimit, 'b.js'), 'export const b = 2;');
    writeFileSync(join(exactLimit, 'logo.png'), 'not-a-script');
    const exactWarnings: string[] = [];
    expect(
      scanForInlinedFirebase(exactLimit, { maxFiles: 2, onWarning: (w) => exactWarnings.push(w) }),
    ).toEqual([]);
    expect(exactWarnings).toEqual([]);

    const overFiles = scratch('pyric-inline-over-files-');
    writeFileSync(join(overFiles, 'a.js'), 'export const a = 1;');
    writeFileSync(join(overFiles, 'b.js'), 'export const b = 2;');
    mkdirSync(join(overFiles, 'nested'));
    writeFileSync(join(overFiles, 'nested', 'c.js'), 'export const c = 3;');
    const fileWarnings: string[] = [];
    expect(
      scanForInlinedFirebase(overFiles, {
        maxFiles: 2,
        publicDirLabel: 'dist',
        onWarning: (w) => fileWarnings.push(w),
      }),
    ).toEqual([]);
    expect(fileWarnings).toHaveLength(1);
    expect(fileWarnings[0]).toContain('inlined-SDK scan of dist stopped early at its file limit (2 files)');
    expect(fileWarnings[0]).toContain('after checking 2 file(s)');

    const overDepth = scratch('pyric-inline-over-depth-');
    const leaf = join(overDepth, 'd1', 'd2', 'd3');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, 'chunk.js'), 'export const x = 1;');
    const depthWarnings: string[] = [];
    expect(
      scanForInlinedFirebase(overDepth, {
        maxDepth: 2,
        publicDirLabel: 'out',
        onWarning: (w) => depthWarnings.push(w),
      }),
    ).toEqual([]);
    expect(depthWarnings).toHaveLength(1);
    expect(depthWarnings[0]).toContain(
      'inlined-SDK scan of out stopped early at its directory depth limit (depth 2)',
    );
  });
});
