/**
 * Compile-time parity against `firebase/ai` for the 14 Hybrid, On-Device,
 * `ChromeAdapter`, and `AgentPlatformBackend` public TypeScript exports in
 * `packages/pyric/src/ai/types-hybrid.ts`.
 */
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import * as FirebaseRuntime from 'firebase/ai';
import type * as Firebase from 'firebase/ai';
import {
  BackendType,
  InferenceMode,
  type AgentPlatformBackend,
  type BaseParams,
  type ChromeAdapter,
  type HybridParams,
  type LanguageModelCreateCoreOptions,
  type LanguageModelCreateOptions,
  type LanguageModelDownloadMonitor,
  type LanguageModelExpected,
  type LanguageModelMessage,
  type LanguageModelMessageContent,
  type LanguageModelMessageContentValue,
  type LanguageModelMessageRole,
  type LanguageModelMessageType,
  type LanguageModelPromptOptions,
  type ModelParams,
  type OnDeviceParams,
  type StartChatParams,
} from '../../src/ai/index.js';
import type * as HybridTypesModule from '../../src/ai/types-hybrid.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Parity = {
  AgentPlatformBackend: Same<AgentPlatformBackend, Firebase.AgentPlatformBackend>;
  BackendType: Same<BackendType, Firebase.BackendType>;
  BaseParams: Same<BaseParams, Firebase.BaseParams>;
  ChromeAdapter: Same<ChromeAdapter, Firebase.ChromeAdapter>;
  HybridParams: Same<HybridParams, Firebase.HybridParams>;
  LanguageModelCreateCoreOptions: Same<
    LanguageModelCreateCoreOptions,
    Firebase.LanguageModelCreateCoreOptions
  >;
  LanguageModelCreateOptions: Same<
    LanguageModelCreateOptions,
    Firebase.LanguageModelCreateOptions
  >;
  LanguageModelDownloadMonitor: Same<
    LanguageModelDownloadMonitor,
    Firebase.LanguageModelDownloadMonitor
  >;
  LanguageModelExpected: Same<LanguageModelExpected, Firebase.LanguageModelExpected>;
  LanguageModelMessage: Same<LanguageModelMessage, Firebase.LanguageModelMessage>;
  LanguageModelMessageContent: Same<
    LanguageModelMessageContent,
    Firebase.LanguageModelMessageContent
  >;
  LanguageModelMessageContentValue: Same<
    LanguageModelMessageContentValue,
    Firebase.LanguageModelMessageContentValue
  >;
  LanguageModelMessageRole: Same<LanguageModelMessageRole, Firebase.LanguageModelMessageRole>;
  LanguageModelMessageType: Same<LanguageModelMessageType, Firebase.LanguageModelMessageType>;
  LanguageModelPromptOptions: Same<
    LanguageModelPromptOptions,
    Firebase.LanguageModelPromptOptions
  >;
  ModelParams: Same<ModelParams, Firebase.ModelParams>;
  OnDeviceParams: Same<OnDeviceParams, Firebase.OnDeviceParams>;
  StartChatParams: Same<StartChatParams, Firebase.StartChatParams>;
  ModuleHybridParams: Same<HybridTypesModule.HybridParams, Firebase.HybridParams>;
};

const parityChecks: { [K in keyof Parity]: true } = {
  AgentPlatformBackend: true,
  BackendType: true,
  BaseParams: true,
  ChromeAdapter: true,
  HybridParams: true,
  LanguageModelCreateCoreOptions: true,
  LanguageModelCreateOptions: true,
  LanguageModelDownloadMonitor: true,
  LanguageModelExpected: true,
  LanguageModelMessage: true,
  LanguageModelMessageContent: true,
  LanguageModelMessageContentValue: true,
  LanguageModelMessageRole: true,
  LanguageModelMessageType: true,
  LanguageModelPromptOptions: true,
  ModelParams: true,
  OnDeviceParams: true,
  StartChatParams: true,
  ModuleHybridParams: true,
};

describe('pyric/ai hybrid, on-device, ChromeAdapter, and AgentPlatformBackend TypeScript parity', () => {
  it('verifies bidirectional assignability against firebase/ai with zero diagnostics', () => {
    expect(parityChecks.AgentPlatformBackend).toBe(true);
    expect(BackendType).toEqual(FirebaseRuntime.BackendType);
    const program = ts.createProgram([import.meta.path], {
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(diagnostics).toEqual([]);
  }, 30_000);

  it('supports strongly typed HybridParams, OnDeviceParams, and ChromeAdapter contracts', async () => {
    const promptMessage: LanguageModelMessage = {
      role: 'system',
      content: [{ type: 'text', value: 'Answer concisely.' }],
    };
    const onDeviceParams: OnDeviceParams = {
      createOptions: {
        temperature: 0.2,
        topK: 3,
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [promptMessage],
      },
      promptOptions: {
        responseConstraint: { type: 'object' },
      },
    };
    const hybridParams: HybridParams = {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams,
      inCloudParams: {
        model: 'gemini-2.5-flash',
        systemInstruction: 'Answer concisely.',
      },
    };
    const adapter: ChromeAdapter = {
      isAvailable: async () => true,
      generateContent: async () => new Response('{}'),
      generateContentStream: async () => new Response('{}'),
    };

    expect(hybridParams.mode).toBe('prefer_on_device');
    expect(await adapter.isAvailable({ contents: [] })).toBe(true);
  });
});
