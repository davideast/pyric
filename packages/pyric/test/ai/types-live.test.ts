/**
 * Compile-time parity against `firebase/ai` for the 24 Live, Speech, and Audio
 * public TypeScript exports in `packages/pyric/src/ai/types-live.ts`.
 */
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import type * as Firebase from 'firebase/ai';
import {
  LiveResponseType,
  ResponseModality,
  type AudioConversationController,
  type AudioTranscriptionConfig,
  type BaseSpeechConfig,
  type ContextWindowCompressionConfig,
  type LiveGenerationConfig,
  type LiveGenerativeModel,
  type LiveModelParams,
  type LiveServerContent,
  type LiveServerGoingAwayNotice,
  type LiveServerToolCall,
  type LiveServerToolCallCancellation,
  type LiveSession,
  type LiveSessionResumptionUpdate,
  type MultiSpeakerSpeechConfig,
  type MultiSpeakerVoiceConfig,
  type PrebuiltVoiceConfig,
  type SessionResumptionConfig,
  type SingleSpeakerSpeechConfig,
  type SlidingWindow,
  type SpeakerVoiceConfig,
  type SpeechConfig,
  type StartAudioConversationOptions,
  type Transcription,
  type VoiceConfig,
} from '../../src/ai/index.js';
import type * as LiveTypesModule from '../../src/ai/types-live.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type PublicShape<T> = { [K in keyof T]: T[K] };

type Parity = {
  AudioConversationController: Same<
    AudioConversationController,
    Firebase.AudioConversationController
  >;
  AudioTranscriptionConfig: Same<AudioTranscriptionConfig, Firebase.AudioTranscriptionConfig>;
  BaseSpeechConfig: Same<BaseSpeechConfig, Firebase.BaseSpeechConfig>;
  ContextWindowCompressionConfig: Same<
    ContextWindowCompressionConfig,
    Firebase.ContextWindowCompressionConfig
  >;
  LiveGenerationConfig: Same<LiveGenerationConfig, Firebase.LiveGenerationConfig>;
  LiveGenerativeModel: Same<
    Omit<LiveGenerativeModel, 'connect'>,
    Omit<PublicShape<Firebase.LiveGenerativeModel>, 'connect'>
  >;
  LiveGenerativeModelConnectParam: Same<
    Parameters<LiveGenerativeModel['connect']>,
    Parameters<Firebase.LiveGenerativeModel['connect']>
  >;
  LiveModelParams: Same<LiveModelParams, Firebase.LiveModelParams>;
  LiveServerContent: Same<LiveServerContent, Firebase.LiveServerContent>;
  LiveServerGoingAwayNotice: Same<
    LiveServerGoingAwayNotice,
    Firebase.LiveServerGoingAwayNotice
  >;
  LiveServerToolCall: Same<LiveServerToolCall, Firebase.LiveServerToolCall>;
  LiveServerToolCallCancellation: Same<
    LiveServerToolCallCancellation,
    Firebase.LiveServerToolCallCancellation
  >;
  LiveSessionPublic: Same<LiveSession, PublicShape<Firebase.LiveSession>>;
  LiveSessionResumptionUpdate: Same<
    LiveSessionResumptionUpdate,
    Firebase.LiveSessionResumptionUpdate
  >;
  MultiSpeakerSpeechConfig: Same<MultiSpeakerSpeechConfig, Firebase.MultiSpeakerSpeechConfig>;
  MultiSpeakerVoiceConfig: Same<MultiSpeakerVoiceConfig, Firebase.MultiSpeakerVoiceConfig>;
  PrebuiltVoiceConfig: Same<PrebuiltVoiceConfig, Firebase.PrebuiltVoiceConfig>;
  SessionResumptionConfig: Same<SessionResumptionConfig, Firebase.SessionResumptionConfig>;
  SingleSpeakerSpeechConfig: Same<SingleSpeakerSpeechConfig, Firebase.SingleSpeakerSpeechConfig>;
  SlidingWindow: Same<SlidingWindow, Firebase.SlidingWindow>;
  SpeakerVoiceConfig: Same<SpeakerVoiceConfig, Firebase.SpeakerVoiceConfig>;
  SpeechConfig: Same<SpeechConfig, Firebase.SpeechConfig>;
  StartAudioConversationOptions: Same<
    StartAudioConversationOptions,
    Firebase.StartAudioConversationOptions
  >;
  Transcription: Same<Transcription, Firebase.Transcription>;
  VoiceConfig: Same<VoiceConfig, Firebase.VoiceConfig>;
  ModuleSpeechConfig: Same<LiveTypesModule.SpeechConfig, Firebase.SpeechConfig>;
};

const parityChecks: { [K in keyof Parity]: true } = {
  AudioConversationController: true,
  AudioTranscriptionConfig: true,
  BaseSpeechConfig: true,
  ContextWindowCompressionConfig: true,
  LiveGenerationConfig: true,
  LiveGenerativeModel: true,
  LiveGenerativeModelConnectParam: true,
  LiveModelParams: true,
  LiveServerContent: true,
  LiveServerGoingAwayNotice: true,
  LiveServerToolCall: true,
  LiveServerToolCallCancellation: true,
  LiveSessionPublic: true,
  LiveSessionResumptionUpdate: true,
  MultiSpeakerSpeechConfig: true,
  MultiSpeakerVoiceConfig: true,
  PrebuiltVoiceConfig: true,
  SessionResumptionConfig: true,
  SingleSpeakerSpeechConfig: true,
  SlidingWindow: true,
  SpeakerVoiceConfig: true,
  SpeechConfig: true,
  StartAudioConversationOptions: true,
  Transcription: true,
  VoiceConfig: true,
  ModuleSpeechConfig: true,
};

describe('pyric/ai live, speech, and audio TypeScript type parity', () => {
  it('verifies bidirectional assignability against firebase/ai with zero diagnostics', () => {
    expect(parityChecks.LiveSessionPublic).toBe(true);
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

  it('supports strongly typed LiveModelParams, SpeechConfig, and server message narrowing', () => {
    const singleSpeech: SpeechConfig = {
      languageCode: 'en-US',
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Puck' },
      },
    };
    const multiSpeech: SpeechConfig = {
      languageCode: 'en-US',
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          { speaker: 'Host', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
        ],
      },
    };
    const params: LiveModelParams = {
      model: 'gemini-2.5-flash-live-preview',
      generationConfig: {
        speechConfig: singleSpeech,
        responseModalities: [ResponseModality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: {
          triggerTokens: 16_000,
          slidingWindow: { targetTokens: 8_000 },
        },
      },
    };
    const message: LiveServerContent | LiveServerGoingAwayNotice = {
      type: 'serverContent',
      turnComplete: true,
      outputTranscription: { text: 'Hello there' },
    };

    expect(params.model).toBe('gemini-2.5-flash-live-preview');
    expect(multiSpeech.languageCode).toBe('en-US');
    expect(message.type).toBe(LiveResponseType.SERVER_CONTENT);
  });
});
