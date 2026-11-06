import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { BUNDLE_SCHEMA, validateBundleManifest } from '../skills/improve-firebase/scripts/lib/contracts.mjs';
import {
  buildScenarioFromAssurance,
  parseCampaignExport,
  selectProbeFromExport,
} from '../skills/improve-firebase/scripts/lib/from-assurance.mjs';
import { probeSystemTools } from '../skills/improve-firebase/scripts/lib/runtime.mjs';
import { probeMedia } from '../skills/improve-firebase/scripts/lib/ffmpeg.mjs';
import { inspectPngFile } from '../skills/improve-firebase/scripts/lib/gates.mjs';
import { EvidenceRecordError, recordEvidence } from '../skills/improve-firebase/scripts/record.mjs';
import { renderEvidenceBundle } from '../skills/improve-firebase/scripts/render.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_EXPORT_PATH = path.join(TEST_DIR, 'fixtures', 'orbit-rtdb-hijack.export.json');

const VULNERABLE_RTDB_RULES = {
  rules: {
    channels: {
      $channelId: {
        messages: {
          $messageId: {
            '.read': 'auth != null',
            '.write': 'auth != null',
          },
        },
      },
    },
  },
};

const FIXED_OWNER_RTDB_RULES = {
  rules: {
    channels: {
      $channelId: {
        messages: {
          $messageId: {
            '.read': 'auth != null',
            '.write':
              "auth != null && (!data.exists() || data.child('authorUid').val() === auth.uid) && (!newData.exists() || newData.child('authorUid').val() === auth.uid)",
          },
        },
      },
    },
  },
};

function createRealtimeAppFixture(rootDir) {
  const distDir = path.join(rootDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Team Chat Sandbox App</title>
  <style>
    body {
      margin: 0;
      padding: 36px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
    }
    .card {
      background: #1e293b;
      border: 2px solid #334155;
      border-radius: 16px;
      padding: 28px;
      max-width: 780px;
    }
    .actor-pill {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      background: #0284c7;
      color: #fff;
      font-weight: 700;
      font-size: 15px;
      margin-bottom: 18px;
    }
    .message-box {
      font-size: 28px;
      line-height: 1.4;
      font-weight: 600;
      padding: 24px;
      border-radius: 12px;
      background: #0b1120;
      border: 1px solid #475569;
    }
    .message-box.hijacked {
      border-color: #ef4444;
      background: #450a0a;
      color: #fecaca;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="actor-pill" id="actor-banner">Signed in</div>
    <div class="message-box" id="message-text">Loading message...</div>
  </div>
  <script>
    const sessionRaw = localStorage.getItem('pyric:serve:auth-session');
    const session = sessionRaw ? JSON.parse(sessionRaw) : { uid: 'anonymous' };
    document.getElementById('actor-banner').textContent = 'Actor: ' + (session.uid || 'anonymous');

    let meta = null;
    async function pollMessage() {
      try {
        if (!meta) {
          const [hRes, iRes] = await Promise.all([
            fetch('/__pyric/health'),
            fetch('/__pyric/init.json'),
          ]);
          const h = hRes.ok ? await hRes.json() : {};
          const init = iRes.ok ? await iRes.json() : {};
          if (h.instanceId || init.instanceId) {
            meta = {
              instanceId: h.instanceId || init.instanceId,
              projectDir:
                init.projectDir ||
                init.projectKey ||
                h.projectDir ||
                h.projectKey ||
                init.workspaceDir,
              databaseURL: init.firebaseConfig && init.firebaseConfig.databaseURL,
            };
          }
        }
        if (!meta) return;
        let data = null;
        if (meta.databaseURL) {
          const cleanDbUrl = meta.databaseURL.endsWith('/')
            ? meta.databaseURL.slice(0, -1)
            : meta.databaseURL;
          const rtdbRes = await fetch(
            cleanDbUrl + '/channels/general/messages/msg_alice_1.json',
          );
          if (rtdbRes.ok) {
            data = await rtdbRes.json();
          }
        }
        if (data === null && meta.projectDir) {
          const res = await fetch('/__pyric/hosted/method', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              instanceId: meta.instanceId,
              projectDir: meta.projectDir,
              key: 'database.get',
              args: { path: 'channels/general/messages/msg_alice_1' },
              allowProduction: false,
            }),
          });
          if (res.ok) {
            const payload = await res.json();
            data = payload && payload.data && payload.data.exists
              ? payload.data.value
              : null;
          }
        }
        if (data !== null) {
          const box = document.getElementById('message-text');
          const txt = data && data.text ? data.text : '(empty)';
          box.textContent = txt;
          if (txt.includes('Wire $25,000')) {
            box.classList.add('hijacked');
          } else {
            box.classList.remove('hijacked');
          }
        }
      } catch {
        // ignore transient poll error during hot reload
      }
    }
    pollMessage();
    setInterval(pollMessage, 100);
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf8');
  return distDir;
}

describe('from-assurance & record -> render integration', () => {
  it('converts CampaignExport probe into validated scenario, control, and exploit ops', () => {
    const rawExport = JSON.parse(fs.readFileSync(FIXTURE_EXPORT_PATH, 'utf8'));
    const campaign = parseCampaignExport(rawExport);
    const probe = selectProbeFromExport(campaign, 'probe-rtdb-cross-tenant-write-01');
    const plan = buildScenarioFromAssurance({ campaignExport: campaign, probe });

    assert.equal(plan.scenario.finding.campaign, 'camp-orbit-rtdb-01');
    assert.equal(plan.scenario.finding.probe, 'probe-rtdb-cross-tenant-write-01');
    assert.equal(plan.scenario.stage.layout, 'data-plane');
    assert.equal(plan.controlOperation.service, 'database');
    assert.equal(plan.controlOperation.uid, 'alice');
    assert.equal(plan.exploitOperation.service, 'database');
    assert.equal(plan.exploitOperation.path, '/channels/general/messages/msg_alice_1');
  });

  it('reproduces exploit + fix in data-plane mode and renders verified 1080p MP4 bundle', async (t) => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-rec-dp-'));
    t.after(() => fs.rmSync(tmpProject, { recursive: true, force: true }));

    const vulnRulesPath = path.join(tmpProject, 'database.rules.json');
    const fixRulesPath = path.join(tmpProject, 'database.fixed.rules.json');
    fs.writeFileSync(vulnRulesPath, JSON.stringify(VULNERABLE_RTDB_RULES, null, 2));
    fs.writeFileSync(fixRulesPath, JSON.stringify(FIXED_OWNER_RTDB_RULES, null, 2));
    fs.writeFileSync(
      path.join(tmpProject, 'firebase.json'),
      JSON.stringify({ database: { rules: 'database.rules.json' } }, null, 2),
    );

    const outRoot = path.join(tmpProject, 'evidence');
    const result = await recordEvidence({
      campaignPath: FIXTURE_EXPORT_PATH,
      probeId: 'probe-rtdb-cross-tenant-write-01',
      fixRulesPath,
      projectDir: tmpProject,
      outDir: outRoot,
      render: true,
      formats: ['mp4'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'reproduced');
    assert.equal(
      fs.existsSync(path.join(tmpProject, '.pyric')),
      false,
      'recordEvidence must never create .pyric in projectDir',
    );

    const manifest = validateBundleManifest(
      JSON.parse(fs.readFileSync(path.join(result.bundleDir, 'manifest.json'), 'utf8')),
    );
    assert.equal(manifest.status, 'reproduced');
    assert.equal(manifest.gates.g1, true);
    assert.equal(manifest.gates.g2, true);
    assert.equal(manifest.gates.g3, true);
    assert.equal(manifest.gates.g4, true);
    assert.equal(manifest.gates.g5, true);
    assert.equal(manifest.gates.g6, true);
    assert.equal(
      manifest.provenanceText,
      'ALLOW → DENY / database.set /channels/general/messages/msg_alice_1 / as mallory / Local Pyric sandbox',
    );

    const videoFile = path.join(result.bundleDir, 'video.mp4');
    assert.ok(fs.existsSync(videoFile));
    const tools = probeSystemTools();
    const probe = await probeMedia({ ffprobePath: tools.ffprobePath, mediaPath: videoFile });
    assert.equal(probe.width, 1920);
    assert.equal(probe.height, 1080);

    const posterStats = inspectPngFile(path.join(result.bundleDir, 'poster.png'));
    assert.equal(posterStats.isBlank, false);
  });

  it('records live 2-actor app-view with DOM expectation, hot-reloads fix rules, and renders split-actors MP4', async (t) => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-rec-app-'));
    t.after(() => fs.rmSync(tmpProject, { recursive: true, force: true }));

    createRealtimeAppFixture(tmpProject);
    const vulnRulesPath = path.join(tmpProject, 'database.rules.json');
    const fixRulesPath = path.join(tmpProject, 'database.fixed.rules.json');
    fs.writeFileSync(vulnRulesPath, JSON.stringify(VULNERABLE_RTDB_RULES, null, 2));
    fs.writeFileSync(fixRulesPath, JSON.stringify(FIXED_OWNER_RTDB_RULES, null, 2));
    fs.writeFileSync(
      path.join(tmpProject, 'firebase.json'),
      JSON.stringify(
        {
          database: { rules: 'database.rules.json' },
          hosting: { public: 'dist', rewrites: [{ source: '**', destination: '/index.html' }] },
        },
        null,
        2,
      ),
    );

    const scenarioPath = path.join(tmpProject, 'scenario.json');
    fs.writeFileSync(
      scenarioPath,
      JSON.stringify(
        {
          schema: 'pyric.evidence.scenario.v1',
          finding: {
            campaign: 'camp-orbit-rtdb-01',
            probe: 'probe-rtdb-cross-tenant-write-01',
          },
          app: { dist: './dist' },
          actors: {
            victim: {
              uid: 'alice',
              name: 'Alice (Owner)',
              view: '/',
              expect: {
                before: { text: 'Q4 vendor invoice approved' },
                after: { text: 'Wire $25,000 to external account today' },
              },
            },
            attacker: {
              uid: 'mallory',
              name: 'Mallory (External)',
              view: '/',
            },
          },
          copy: {
            title: 'Cross-tenant RTDB message overwrite',
            exploit: 'Mallory overwrites Alice invoice message in real time',
            why: 'Write rule omitted authorUid ownership verification',
          },
          fixRules: {
            rtdb: './database.fixed.rules.json',
          },
        },
        null,
        2,
      ),
    );

    const outRoot = path.join(tmpProject, 'evidence');
    const cdpResult = await recordEvidence({
      campaignPath: FIXTURE_EXPORT_PATH,
      probeId: 'probe-rtdb-cross-tenant-write-01',
      scenarioPath,
      projectDir: tmpProject,
      backend: 'cdp',
      outDir: path.join(outRoot, 'cdp-run'),
      render: true,
      formats: ['mp4'],
    });

    assert.equal(cdpResult.ok, true);
    assert.equal(cdpResult.status, 'reproduced');
    assert.ok(fs.existsSync(path.join(cdpResult.bundleDir, 'raw', 'capture.json')));
    assert.ok(fs.existsSync(path.join(cdpResult.bundleDir, 'video.mp4')));

    const cdpManifest = JSON.parse(
      fs.readFileSync(path.join(cdpResult.bundleDir, 'manifest.json'), 'utf8'),
    );
    assert.equal(cdpManifest.backend, 'cdp-surface');
    assert.deepEqual(cdpManifest.gates, {
      g1: true,
      g2: true,
      g3: true,
      g4: true,
      g5: true,
      g6: true,
    });

    // Also exercise default backend ('auto', X11XvfbBackend on Linux when Xvfb+ffmpeg exist)
    const autoResult = await recordEvidence({
      campaignPath: FIXTURE_EXPORT_PATH,
      probeId: 'probe-rtdb-cross-tenant-write-01',
      scenarioPath,
      projectDir: tmpProject,
      backend: 'auto',
      outDir: path.join(outRoot, 'auto-run'),
      render: true,
      formats: ['mp4'],
    });
    assert.equal(autoResult.ok, true);
    assert.equal(autoResult.status, 'reproduced');
    assert.ok(fs.existsSync(path.join(autoResult.bundleDir, 'raw', 'capture.json')));
    assert.ok(fs.existsSync(path.join(autoResult.bundleDir, 'video.mp4')));
    const autoCapture = JSON.parse(
      fs.readFileSync(path.join(autoResult.bundleDir, 'raw', 'capture.json'), 'utf8'),
    );
    if (autoCapture.mode === 'video') {
      assert.ok(typeof autoCapture.videoPath === 'string' && fs.existsSync(autoCapture.videoPath));
      assert.ok(autoCapture.cropRects && autoCapture.cropRects.victim && autoCapture.cropRects.attacker);
      assert.ok(Array.isArray(autoCapture.packetTimestampsMs) && autoCapture.packetTimestampsMs.length >= 2);
    } else {
      assert.ok(Array.isArray(autoCapture.frames) && autoCapture.frames.length >= 2);
    }
    const autoManifest = JSON.parse(
      fs.readFileSync(path.join(autoResult.bundleDir, 'manifest.json'), 'utf8'),
    );
    assert.deepEqual(autoManifest.gates, {
      g1: true,
      g2: true,
      g3: true,
      g4: true,
      g5: true,
      g6: true,
    });
  });

  it('marks bundle not-reproduced with zero video when Gate G3, Gate G4, or Gate G5 fails', async (t) => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'pyric-rec-fail-'));
    t.after(() => fs.rmSync(tmpProject, { recursive: true, force: true }));

    // Case 1: Rules already block the exploit -> Gate G3 fails
    const secureRulesPath = path.join(tmpProject, 'database.rules.json');
    fs.writeFileSync(secureRulesPath, JSON.stringify(FIXED_OWNER_RTDB_RULES, null, 2));
    fs.writeFileSync(
      path.join(tmpProject, 'firebase.json'),
      JSON.stringify({ database: { rules: 'database.rules.json' } }, null, 2),
    );

    const outRoot = path.join(tmpProject, 'evidence');
    await assert.rejects(
      () =>
        recordEvidence({
          campaignPath: FIXTURE_EXPORT_PATH,
          probeId: 'probe-rtdb-cross-tenant-write-01',
          projectDir: tmpProject,
          outDir: outRoot,
        }),
      (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G3_FAILED',
    );

    const bundleDir = path.join(outRoot, 'probe-rtdb-cross-tenant-write-01');
    assert.equal(fs.existsSync(path.join(bundleDir, 'video.mp4')), false);
    const failedManifest = JSON.parse(
      fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'),
    );
    assert.equal(failedManifest.status, 'not-reproduced');
    assert.equal(failedManifest.failedGate, 'G3');

    // render.mjs must also refuse to render this not-reproduced bundle
    await assert.rejects(
      () => renderEvidenceBundle({ evidenceDir: bundleDir }),
      (err) => err.code === 'UNVERIFIED_FINDING',
    );

    // Case 2: Vulnerable rules allow exploit, but broken candidate fix still allows exploit -> Gate G5 fails
    fs.writeFileSync(secureRulesPath, JSON.stringify(VULNERABLE_RTDB_RULES, null, 2));
    const brokenFixPath = path.join(tmpProject, 'database.broken-fix.rules.json');
    fs.writeFileSync(brokenFixPath, JSON.stringify(VULNERABLE_RTDB_RULES, null, 2));

    await assert.rejects(
      () =>
        recordEvidence({
          campaignPath: FIXTURE_EXPORT_PATH,
          probeId: 'probe-rtdb-cross-tenant-write-01',
          projectDir: tmpProject,
          rtdbRulesPath: brokenFixPath,
          outDir: path.join(outRoot, 'g5-fail'),
        }),
      (err) => err instanceof EvidenceRecordError && err.code === 'GATE_G5_FAILED',
    );
    const g5BundleDir = path.join(outRoot, 'g5-fail', 'probe-rtdb-cross-tenant-write-01');
    assert.equal(fs.existsSync(path.join(g5BundleDir, 'video.mp4')), false);
    const g5Manifest = JSON.parse(
      fs.readFileSync(path.join(g5BundleDir, 'manifest.json'), 'utf8'),
    );
    assert.equal(g5Manifest.status, 'not-reproduced');
    assert.equal(g5Manifest.failedGate, 'G5');
  });
});
