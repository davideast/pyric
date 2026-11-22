import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNodeExecutable } from '../../require-node-on-path.js';

interface NodeScriptResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function collectChildProcess(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<NodeScriptResult> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`Node child timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.once('exit', (status, signal) => { clearTimeout(timer); resolveExit({ status, signal, stdout, stderr }); });
  });
}

export function runPlainNodeScript(projectDir: string, scriptName: string, source: string, timeoutMs = 45_000): Promise<NodeScriptResult> {
  const scriptPath = join(projectDir, scriptName);
  writeFileSync(scriptPath, source);
  const nodeBin = resolveNodeExecutable();
  const child = spawn(nodeBin, [scriptPath], {
    cwd: projectDir,
    env: { ...process.env, NODE_ENV: undefined, PYRIC_SANDBOX: undefined, PYRIC_SANDBOX_FORCE: undefined, PYRIC_SANDBOX_INSTANCE: undefined } as NodeJS.ProcessEnv,
  });
  return collectChildProcess(child, timeoutMs);
}

export function buildFirestoreSsrScripts(
  basePath: string,
  plainUid: string,
  seedEntries: Record<string, Record<string, unknown>>,
): { sharedWorkerScript: string; hostedScript: string } {
  const ssrClientModule = `
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
function appOnce() { const apps = getApps(); if (apps.length > 0) return apps[0]; return initializeApp({ apiKey: 'demo', appId: 'demo', projectId: 'demo-oracle' }); }
function errorCodeOf(err) { if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code; return 'unknown'; }
export async function runSsrRulesProbe({ plainToken, claimedToken }) {
  const app = appOnce(); const db = getFirestore(app); const auth = getAuth(app);
  const basePath = ${JSON.stringify(basePath)}; const plainUid = ${JSON.stringify(plainUid)};
  async function readOutcome(rel) { try { await getDoc(doc(db, basePath + '/' + rel)); return 'allowed'; } catch (e) { return 'error:' + errorCodeOf(e); } }
  async function setOutcome(rel, data) { try { await setDoc(doc(db, basePath + '/' + rel), data); return 'allowed'; } catch (e) { return 'error:' + errorCodeOf(e); } }
  async function updateOutcome(rel, data) { try { await updateDoc(doc(db, basePath + '/' + rel), data); return 'allowed'; } catch (e) { return 'error:' + errorCodeOf(e); } }
  const unauthedRead = await readOutcome('anon_only/doc1');
  const unauthedWrite = await setOutcome('claim_gated/doc3', { edited: true });
  await signInWithCustomToken(auth, plainToken);
  const signedInRead = await readOutcome('anon_only/doc1');
  const enabledAclRead = await readOutcome('cross_doc/enabled_doc');
  const disabledAclRead = await readOutcome('cross_doc/disabled_doc');
  const existsGuardMissingAclRead = await readOutcome('cross_doc/missing_acl');
  const crossDocIdRead = await readOutcome('cross_doc_id/enabled_doc');
  const crossDocIdNotEqZzzRead = await readOutcome('cross_doc_id_not_eq/enabled_doc');
  const crossDocNameRead = await readOutcome('cross_doc_name/enabled_doc');
  const unguardedMissingGetRead = await readOutcome('unguarded_missing_get/doc1');
  const validCreate = await setOutcome('validated_creates/valid', { title: 'Hello' });
  const emptyTitleCreate = await setOutcome('validated_creates/empty', { title: '' });
  const nonStringTitleCreate = await setOutcome('validated_creates/num', { title: 42 });
  const missingTitleFieldCreate = await setOutcome('validated_creates/missing', { other: 'x' });
  const ownerMatchUpdate = await updateOutcome('owned_updates/mine', { count: 2 });
  const ownerChangeAttempt = await updateOutcome('owned_updates/mine', { owner: 'hijack', count: 3 });
  const ownerMismatchUpdate = await updateOutcome('owned_updates/other', { count: 2 });
  const missingOwnerFieldOnExistingDoc = await updateOutcome('owned_updates/no_owner_field', { owner: plainUid, count: 2 });
  const plainSignedInWrite = await setOutcome('claim_gated/doc2', { edited: true });
  const sparseUpdatePreservingKeep = await updateOutcome('merged_updates/for_update', { step: 2 });
  const fullSetDroppingKeep = await setOutcome('merged_updates/for_replace', { step: 2 });
  await signInWithCustomToken(auth, claimedToken);
  const claimedWrite = await setOutcome('claim_gated/doc1', { edited: true });
  return {
    anonOnly: { unauthedRead, signedInRead },
    crossDoc: { enabledAclRead, disabledAclRead, existsGuardMissingAclRead, crossDocIdRead, crossDocIdNotEqZzzRead, crossDocNameRead, unguardedMissingGetRead },
    requestResourceValidation: { validCreate, emptyTitleCreate, nonStringTitleCreate, missingTitleFieldCreate },
    existingResourceField: { ownerMatchUpdate, ownerChangeAttempt, ownerMismatchUpdate, missingOwnerFieldOnExistingDoc },
    customClaims: { claimedWrite, plainSignedInWrite, unauthedWrite },
    updateMergedRequestResource: { sparseUpdatePreservingKeep, fullSetDroppingKeep },
  };
}
export async function readSharedSession() {
  const app = appOnce(); const auth = getAuth(app); let uid = null;
  if (auth.currentUser) uid = auth.currentUser.uid;
  await getDoc(doc(getFirestore(app), ${JSON.stringify(`${basePath}/__ready/check`)}));
  return { appCount: getApps().length, uid };
}
`;
  const ssrAdminModule = `
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
function adminOnce() { const apps = getApps(); if (apps.length > 0) return apps[0]; return initializeApp(); }
export async function prepareFixture() {
  const app = adminOnce(); const db = getFirestore(app);
  const auth = getAuth(initializeApp({ projectId: 'demo-oracle' }, 'ssr-token-minter'));
  const seeds = ${JSON.stringify(seedEntries)}; const basePath = ${JSON.stringify(basePath)};
  for (const [rel, data] of Object.entries(seeds)) await db.doc(basePath + '/' + rel).set(data);
  await db.doc(basePath + '/browser_seed/doc1').set({ from: 'browser-client' });
  return { plainToken: await auth.createCustomToken(${JSON.stringify(plainUid)}), claimedToken: await auth.createCustomToken('editor_ssr', { role: 'editor', tier: 2 }) };
}
export async function readAcrossRules() {
  const db = getFirestore(adminOnce()); const basePath = ${JSON.stringify(basePath)};
  return {
    ownedDoc: (await db.doc(basePath + '/owned_updates/mine').get()).data(),
    claimedDoc: (await db.doc(basePath + '/claim_gated/doc1').get()).data(),
    browserDoc: (await db.doc(basePath + '/browser_seed/doc1').get()).data(),
  };
}
`;
  const sharedWorkerScript = `
import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { createServer } from 'vite'; import { pyric } from '@pyric/cli/vite';
writeFileSync(join(process.cwd(), 'ssr-client.mjs'), ${JSON.stringify(ssrClientModule)});
writeFileSync(join(process.cwd(), 'ssr-admin.mjs'), ${JSON.stringify(ssrAdminModule)});
const swServer = await createServer({ appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(), plugins: [pyric({ hosted: false, ui: false, capture: false, project: 'demo-oracle' })], server: { port: 0, host: '127.0.0.1' }, optimizeDeps: { noDiscovery: true } });
await swServer.listen();
function extractRefusal(err) { let code = null; let message = String(err); if (err && typeof err === 'object') { if (typeof err.code === 'string') code = err.code; if (typeof err.message === 'string') message = err.message; } return { code, message }; }
let rs2Refusal = { code: null, message: '' }; try { const swClient = await swServer.ssrLoadModule('/ssr-client.mjs'); await swClient.readSharedSession(); } catch (err) { rs2Refusal = extractRefusal(err); }
let rs3Refusal = { code: null, message: '' }; try { const swAdmin = await swServer.ssrLoadModule('/ssr-admin.mjs'); await swAdmin.readAcrossRules(); } catch (err) { rs3Refusal = extractRefusal(err); }
await swServer.close();
console.log('VITE_SW_REFUSAL ' + JSON.stringify({ rs2Refusal, rs3Refusal }));
`;
  const hostedScript = `
import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { createServer } from 'vite'; import { pyric } from '@pyric/cli/vite';
writeFileSync(join(process.cwd(), 'ssr-client.mjs'), ${JSON.stringify(ssrClientModule)});
writeFileSync(join(process.cwd(), 'ssr-second.mjs'), 'export { readSharedSession } from "./ssr-client.mjs";\\n');
writeFileSync(join(process.cwd(), 'ssr-admin.mjs'), ${JSON.stringify(ssrAdminModule)});
const hostedServer = await createServer({ appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(), ssr: { noExternal: ['firebase'] }, plugins: [pyric({ hosted: true, ui: false, capture: false, project: 'demo-oracle' })], server: { port: 0, host: '127.0.0.1' }, optimizeDeps: { noDiscovery: true } });
await hostedServer.listen();
const adminMod = await hostedServer.ssrLoadModule('/ssr-admin.mjs'); const tokens = await adminMod.prepareFixture();
const clientMod = await hostedServer.ssrLoadModule('/ssr-client.mjs'); const verdicts = await clientMod.runSsrRulesProbe(tokens);
const secondMod = await hostedServer.ssrLoadModule('/ssr-second.mjs'); const sharedSession = await secondMod.readSharedSession();
const adminReadBack = await adminMod.readAcrossRules();
await hostedServer.close();
console.log('VITE_SSR_RESULT ' + JSON.stringify({ verdicts, sharedSession, adminReadBack }));
`;
  return { sharedWorkerScript, hostedScript };
}
