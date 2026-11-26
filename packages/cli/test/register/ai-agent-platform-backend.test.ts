import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerDist = join(cliRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;

const PROBE_SCRIPT = `
import { deleteApp, initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import {
  AgentPlatformBackend,
  Backend,
  BackendType,
  getAI,
  getGenerativeModel,
} from 'firebase/ai';
import { script } from 'pyric/ai/scripting';
import { mintAppCheckToken } from 'pyric/sandbox/internal';

const app = initializeApp({
  apiKey: 'demo-key',
  projectId: 'demo-reg-ai',
  appId: '1:100000000000:web:regai01',
});
initializeAppCheck(app, {
  provider: new CustomProvider({
    getToken: () =>
      mintAppCheckToken(
        { appId: '1:100000000000:web:regai01', projectId: 'demo-reg-ai' },
        3600,
      ),
  }),
});

const defaultAi = getAI(app, { backend: new AgentPlatformBackend() });
const regionalAi = getAI(app, { backend: new AgentPlatformBackend('us-central1') });
script(defaultAi, [{ respond: { text: 'reg-agent-ok' } }]);
const model = getGenerativeModel(regionalAi, { model: 'gemini-2.5-flash' });
const reply = await model.generateContent('ping');

console.log(JSON.stringify({
  isBackend: defaultAi.backend instanceof Backend && defaultAi.backend instanceof AgentPlatformBackend,
  type: defaultAi.backend.backendType === BackendType.AGENT_PLATFORM,
  defaultLoc: defaultAi.backend.location,
  regionalLoc: regionalAi.backend.location,
  distinctHandles: defaultAi !== regionalAi,
  model: model.model,
  text: reply.response.text(),
}));
await deleteApp(app);
`;

describe('registered Node firebase/ai AgentPlatformBackend (#1674)', () => {
  it('supports AgentPlatformBackend and BackendType.AGENT_PLATFORM under @pyric/cli/register (PYRIC_SANDBOX=local)', async () => {
    if (!existsSync(registerDist)) {
      throw new Error(`dist/register/index.js missing -- run \`bun run --cwd packages/cli build\` first (${registerDist})`);
    }
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
      const child = spawn('node', ['--import', registerUrl, '--input-type=module', '-e', PROBE_SCRIPT], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: undefined,
          PYRIC_SANDBOX: 'local',
          PYRIC_SANDBOX_INSTANCE: undefined,
          PYRIC_SANDBOX_FORCE: undefined,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill();
        rejectRun(new Error(`node child timed out; stderr=${stderr}`));
      }, 20_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectRun(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveRun({ status: code, stdout, stderr });
      });
    });

    expect(res.status, res.stderr).toBe(0);
    const line = res.stdout.trim().split('\n').find((item) => item.startsWith('{')) ?? '{}';
    expect(JSON.parse(line)).toEqual({
      isBackend: true,
      type: true,
      defaultLoc: 'global',
      regionalLoc: 'us-central1',
      distinctHandles: true,
      model: 'publishers/google/models/gemini-2.5-flash',
      text: 'reg-agent-ok',
    });
  });
});
