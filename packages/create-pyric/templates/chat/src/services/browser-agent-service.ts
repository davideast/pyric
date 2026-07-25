import { getGenerativeModel } from 'firebase/ai';
import type { Content } from 'firebase/ai';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm?url';
import { createFirebaseAiLogicModelClient } from '@inbrowser/model';
import {
  createAgentSession,
  createAgentTools,
  createMetricsCollector,
  createReactLoopStrategy,
  createToolRegistry,
  editToolResults,
  shouldCompact,
} from '@inbrowser/agent';
import type { ChatMessage, ModelUsage, SessionEvent } from '@inbrowser/agent';
import { createBrowserWorkspace } from './browser-workspace-runtime';
import type { BrowserWorkspace } from '@inbrowser/workspace';
import type { WorkspaceAgentToolHandler } from '@inbrowser/workspace/agent-tools';
import { ai, auth } from '../firebase/app';
import type { ChatMode } from '../chat-mode';
import type { UiMessage, UiToolCall, UiUsage } from '../ui/chat/chat-types';
import { AgentRunRecorder } from './agent-run-store';

const MODEL = 'gemini-3.5-flash';
const MAX_MESSAGES = 40;
const modeInstructions: Record<ChatMode, string> = {
  explore: 'Help the user explore possibilities. Surface alternatives, assumptions, and useful questions before converging.',
  plan: 'Help the user turn ideas into a practical plan. Clarify the desired outcome, sequence the work, and identify the next concrete step.',
  refine: 'Help the user pressure-test and improve the current direction. Identify weaknesses, tradeoffs, and specific refinements without discarding useful intent.',
  direct: 'You are a direct, helpful AI assistant. Answer questions clearly and accurately without assumptions.',
};

type AgentCallbacks = {
  onChunk: (chunk: string) => void;
  onThought?: (thought: string) => void;
  onTool?: (tool: UiToolCall) => void;
  onUsage?: (usage: UiUsage) => void;
  onWorkspaceChanged?: () => void;
};

type AgentResult = {
  text: string;
  thoughts: string;
  usage?: UiUsage;
};

const toAgentMessage = (message: Pick<UiMessage, 'role' | 'text'>, index: number): ChatMessage => ({
  id: `history-${index}`,
  role: message.role === 'system' ? 'system' : message.role,
  text: message.text,
});

const toUiUsage = (usage: ModelUsage): UiUsage => ({
  inputTokens: usage.promptTokens,
  outputTokens: usage.outputTokens,
  reasoningTokens: usage.reasoningTokens,
  cachedTokens: usage.cachedTokens,
  costUsd: usage.costUsd,
});

const generationConfig = {
  maxOutputTokens: 8192,
  thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
};

export class BrowserAgentService {
  private workspacePromise: Promise<BrowserWorkspace> | null = null;
  private readonly workspaceListeners = new Set<() => void>();

  private workspace(): Promise<BrowserWorkspace> {
    if (!this.workspacePromise) {
      this.workspacePromise = createBrowserWorkspace({
        id: 'PyChat-workspace',
        root: '/work',
        storage: 'opfs-with-memory-fallback',
      }).then(async (workspace: BrowserWorkspace) => {
        try {
          await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
        } catch {
          await workspace.fs.promises.writeFile('/work/package.json', JSON.stringify({ name: 'PyChat-workspace', private: true, dependencies: { react: 'latest', 'react-dom': 'latest' } }, null, 2));
          await workspace.fs.promises.writeFile('/work/src/App.tsx', "export default function App() {\n  return <main style={{ padding: 24, fontFamily: 'system-ui' }}>Your workspace is ready.</main>;\n}\n");
        }
        return workspace;
      });
    }
    return this.workspacePromise!;
  }

  private notifyWorkspaceChanged(): void {
    this.workspaceListeners.forEach((listener) => listener());
  }

  async readAppSource(): Promise<string> {
    const workspace = await this.workspace();
    return workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
  }

  subscribe(callback: () => void): () => void {
    this.workspaceListeners.add(callback);
    return () => this.workspaceListeners.delete(callback);
  }

  async previewApp(source: string, hostModules: { react: Record<string, unknown>; jsxRuntime: Record<string, unknown>; jsxDevRuntime: Record<string, unknown> }): Promise<{ ok: true; component: unknown } | { ok: false; diagnostics: Array<{ message: string; line?: number; column?: number }> }> {
    const workspace = await this.workspace();
    const preview = await workspace.createReactPreview({
      entry: '/work/src/App.tsx',
      react: hostModules.react,
      jsxRuntime: hostModules.jsxRuntime,
      jsxDevRuntime: hostModules.jsxDevRuntime,
      esbuildOptions: { wasmURL: esbuildWasmUrl },
    });
    const result = await preview.compile(source);
    if (!result.ok) return result;
    const evaluated = result.evaluate(preview.scope());
    const component = (evaluated as { default?: unknown })?.default ?? evaluated;
    return { ok: true, component };
  }

  async stream(input: { messages: Pick<UiMessage, 'role' | 'text'>[]; mode?: ChatMode; signal?: AbortSignal }, callbacks: AgentCallbacks): Promise<AgentResult> {
    if (!auth.currentUser) throw new Error('Sign in is required');
    const workspace = await this.workspace();
    const handlers = createBrowserWorkspaceTools(workspace);
    const registry = createToolRegistry();
    handlers.forEach((handler) => registry.register(handler));
    const model = getGenerativeModel(ai, {
      model: MODEL,
      systemInstruction: modeInstructions[input.mode ?? 'explore'],
      generationConfig,
    });
    const llm = createFirebaseAiLogicModelClient(model, { id: `firebase-ai-logic:${MODEL}` });
    const history = input.messages.slice(-MAX_MESSAGES).map(toAgentMessage);
    const managedHistory = editToolResults(history);
    const compaction = shouldCompact(managedHistory.messages, { windowTokens: 200_000 });
    const activeSignal = input.signal ?? new AbortController().signal;
    const run = new AgentRunRecorder({ model: MODEL, mode: input.mode ?? 'explore' });
    const session = createAgentSession({
      // A thinking-heavy local model often ends a turn after thinking with no
      // tool call or text (gemini.thinking_only_stop). Under the default
      // 'strict' policy that surfaces as "produced no output" even when the
      // agent already did the work; 'complete-with-warning' lets the loop
      // settle on the tool progress it made instead of failing the response.
      strategy: createReactLoopStrategy({ maxTurns: 12, toolProgressErrorPolicy: 'complete-with-warning' }),
      llm,
      tools: createAgentTools(registry),
      toolContext: () => ({ signal: activeSignal, workspace: workspace as never }),
      systemPromptBuilder: () => `${modeInstructions[input.mode ?? 'explore']}\n\nYou are working inside PyChat's browser workspace. The workspace root is /work and already contains package.json and src/App.tsx — src/App.tsx is the app entry (a default-exported React component that renders into the preview). To build or change the app, write src/App.tsx. Paths resolve under /work, so "src/App.tsx", "/src/App.tsx", and "/work/src/App.tsx" all mean the same file, and "/" lists the root. This layout is fixed — do not spend turns probing for it; read or write src/App.tsx directly. Preview contract: src/App.tsx must \`export default\` a function component — literally \`export default function App() { return <h1>Hello</h1>; }\`. Do NOT export a JSX element (\`export default <h1>Hello</h1>\`) and do NOT call the component (\`export default App()\`); the export must be the function itself, which the preview mounts for you. Import hooks from 'react' (e.g. \`import { useState } from 'react'\`); 'react' is already provided, so never install it. Do NOT import 'react-dom' and do NOT call render() or createRoot() — those are not available and will fail to resolve; the preview does the mounting. A component that returns null compiles but shows a blank preview, so the default export must return the actual requested UI. For any request, make the change and call workspace_preview; a successful compile is not the same as rendering the requested content — verify the component returns visible JSX before claiming it renders. Keep the final response concise and tell the user what changed. ${compaction.compact ? 'Prefer the most recent context and verify the current files before editing.' : ''}`,
      metrics: createMetricsCollector(),
      history: managedHistory.messages,
    });
    let text = '';
    let thoughts = '';
    let usage: UiUsage | undefined;
    const toolNames = new Map<string, string>();
    const prompt = input.messages.at(-1)?.text ?? '';
    const recordingCallbacks: AgentCallbacks = {
      ...callbacks,
      onTool: (tool) => {
        run.push({ kind: 'tool', tool });
        callbacks.onTool?.(tool);
      },
    };
    try {
      for await (const event of session.submit(prompt, activeSignal)) {
        this.handleEvent(event, recordingCallbacks, toolNames, (chunk) => { text += chunk; run.push({ kind: 'text', chunk }); }, (chunk) => { thoughts += chunk; run.push({ kind: 'thinking', chunk }); }, (nextUsage) => { usage = nextUsage; run.push({ kind: 'usage', usage: nextUsage }); });
      }
      if (/workspace|render .*app|react app|app\.tsx/i.test(prompt)) {
        const verificationId = `workspace_preview_${Date.now()}`;
        const verificationTool: UiToolCall = { id: verificationId, name: 'workspace_preview', args: {}, status: 'running' };
        run.push({ kind: 'tool', tool: verificationTool });
        recordingCallbacks.onTool?.(verificationTool);
        try {
          const verification = await this.verifyWorkspacePreview(workspace);
          const completed: UiToolCall = verification.ok
            ? { ...verificationTool, status: 'complete', summary: 'preview compiled successfully' }
            : { ...verificationTool, status: 'error', summary: verification.message };
          run.push({ kind: 'tool', tool: completed });
          recordingCallbacks.onTool?.(completed);
        } catch (error) {
          const failed: UiToolCall = { ...verificationTool, status: 'error', summary: error instanceof Error ? error.message : 'preview verification failed' };
          run.push({ kind: 'tool', tool: failed });
          recordingCallbacks.onTool?.(failed);
        }
      }
      run.finish();
    } catch (error) {
      run.fail(error instanceof Error ? error.message : 'Agent run failed');
      throw error;
    } finally {
      window.setTimeout(() => void run.dispose(), 30_000);
    }
    return { text, thoughts, usage };
  }

  private async verifyWorkspacePreview(workspace: BrowserWorkspace): Promise<{ ok: true } | { ok: false; message: string }> {
    const source = await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
    const preview = await workspace.createReactPreview({
      entry: '/work/src/App.tsx',
      react: React as unknown as Record<string, unknown>,
      jsxRuntime: jsxRuntime as unknown as Record<string, unknown>,
      jsxDevRuntime: jsxDevRuntime as unknown as Record<string, unknown>,
      esbuildOptions: { wasmURL: esbuildWasmUrl },
    });
    const result = await preview.compile(source);
    return result.ok ? { ok: true } : { ok: false, message: result.diagnostics.map((diagnostic) => diagnostic.message).join('; ') };
  }

  private handleEvent(event: SessionEvent, callbacks: AgentCallbacks, toolNames: Map<string, string>, appendText: (chunk: string) => void, appendThought: (chunk: string) => void, setUsage: (usage: UiUsage) => void): void {
    if (event.kind === 'text') {
      appendText(event.chunk);
      callbacks.onChunk(event.chunk);
    } else if (event.kind === 'thinking') {
      appendThought(event.chunk);
      callbacks.onThought?.(event.chunk);
    } else if (event.kind === 'tool_started') {
      toolNames.set(event.callId, event.name);
      callbacks.onTool?.({ id: event.callId, name: event.name, args: event.args, status: 'running' });
    } else if (event.kind === 'tool_finished') {
      callbacks.onTool?.({ id: event.callId, name: toolNames.get(event.callId) ?? event.callId, args: {}, status: event.result.ok ? 'complete' : 'error', summary: event.result.summary });
      this.notifyWorkspaceChanged();
      callbacks.onWorkspaceChanged?.();
    } else if (event.kind === 'turn_completed') {
      const nextUsage = toUiUsage({ promptTokens: event.metrics.tokensIn, outputTokens: event.metrics.tokensOut, reasoningTokens: event.metrics.tokensReasoning, cachedTokens: event.metrics.tokensCached, costUsd: event.metrics.costUsd });
      setUsage(nextUsage);
      callbacks.onUsage?.(nextUsage);
    } else if (event.kind === 'error') {
      throw new Error(event.message);
    }
  }
}

const WORKSPACE_ROOT = '/work';

/**
 * Map an agent-supplied path into the workspace mount. The fs is rooted so
 * everything lives under `/work`, but agents naturally reach for `/`, `/src`,
 * or `src/App.tsx`. Resolve all of those under `/work` so a stray leading slash
 * or a root listing never throws "outside /work" — that error gave the model
 * nothing to correct toward and sent it into a path-guessing loop that spent
 * its whole output budget on thinking, ending in finishReason=STOP with no
 * tool call ("produced no output — response ended after thinking only").
 */
function resolveWorkspacePath(path: string): string {
  const trimmed = (path ?? '').trim();
  if (!trimmed || trimmed === '/' || trimmed === '.' || trimmed === './') return WORKSPACE_ROOT;
  const cleaned = trimmed.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === WORKSPACE_ROOT || cleaned.startsWith(`${WORKSPACE_ROOT}/`)) return cleaned || WORKSPACE_ROOT;
  const relative = cleaned.replace(/^\/+/, '');
  return relative ? `${WORKSPACE_ROOT}/${relative}` : WORKSPACE_ROOT;
}

function createBrowserWorkspaceTools(workspace: BrowserWorkspace): WorkspaceAgentToolHandler[] {
  const stringSchema = () => ({ type: 'string' });
  const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    {
      name: 'workspace_read_file',
      description: 'Read a UTF-8 file from the browser workspace. Paths are under the workspace root /work; "/work/src/App.tsx", "src/App.tsx", and "/src/App.tsx" all resolve to the same file.',
      parameters: objectSchema({ path: stringSchema() }, ['path']),
      pure: true,
      async execute(args: { path: string }) {
        const path = resolveWorkspacePath(args.path);
        const content = await workspace.fs.promises.readFile(path, 'utf8');
        return { ok: true, summary: `read ${path}`, data: { path, content } };
      },
    },
    {
      name: 'workspace_write_file',
      description: 'Write a UTF-8 file in the browser workspace, creating parent directories as needed. Paths are under the workspace root /work (e.g. "src/App.tsx").',
      parameters: objectSchema({ path: stringSchema(), content: stringSchema() }, ['path', 'content']),
      async execute(args: { path: string; content: string }) {
        const path = resolveWorkspacePath(args.path);
        await workspace.fs.promises.writeFile(path, args.content);
        return { ok: true, summary: `wrote ${path}`, data: { path, bytes: new TextEncoder().encode(args.content).byteLength } };
      },
    },
    {
      name: 'workspace_list_files',
      description: 'List files or directories in the browser workspace. Use "/" (or "/work") for the workspace root; paths resolve under /work.',
      parameters: objectSchema({ path: stringSchema() }, ['path']),
      pure: true,
      async execute(args: { path: string }) {
        const path = resolveWorkspacePath(args.path);
        const entries = await workspace.fs.promises.readdir(path, { withFileTypes: true });
        return { ok: true, summary: `listed ${path}`, data: { path, entries: entries.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type })) } };
      },
    },
    {
      name: 'workspace_package_install',
      description: 'Add a browser-compatible package to the workspace import map.',
      parameters: objectSchema({ name: stringSchema(), version: stringSchema() }, ['name']),
      async execute(args: { name: string; version?: string }) {
        const installed = await workspace.packages.install({ name: args.name, version: args.version });
        return { ok: true, summary: `installed ${installed.name}@${installed.version}`, data: installed };
      },
    },
    {
      name: 'workspace_preview',
      description: 'Compile the current React app and report whether it renders successfully. Use after editing workspace files.',
      parameters: objectSchema({}),
      pure: true,
      async execute() {
        const source = await workspace.fs.promises.readFile('/work/src/App.tsx', 'utf8');
        const preview = await workspace.createReactPreview({
          entry: '/work/src/App.tsx',
          react: React as unknown as Record<string, unknown>,
          jsxRuntime: jsxRuntime as unknown as Record<string, unknown>,
          jsxDevRuntime: jsxDevRuntime as unknown as Record<string, unknown>,
          esbuildOptions: { wasmURL: esbuildWasmUrl },
        });
        const result = await preview.compile(source);
        if (!result.ok) return { ok: false, summary: `preview failed: ${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`, data: result.diagnostics };
        return { ok: true, summary: 'preview compiled successfully' };
      },
    },
  ];
}
