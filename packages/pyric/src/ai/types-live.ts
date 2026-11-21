/**
 * Public TypeScript contracts for Firebase AI Live, Speech, and Audio
 * capabilities owned by `pyric/ai`.
 *
 * `LiveGenerativeModel` and `LiveSession` are exported only in the TypeScript
 * type namespace so the deferred runtime dispositions in
 * `packages/conformance/surfaces/ai.json` remain accurate.
 */
import type { ResponseModality } from './enums.js';
import type {
  Content,
  FunctionCall,
  FunctionResponse,
  GenerativeContentBlob,
  Part,
  Tool,
  ToolConfig,
} from './types.js';

export interface AudioConversationController {
  stop: () => Promise<void>;
}

export interface AudioTranscriptionConfig {}

export interface BaseSpeechConfig {
  languageCode?: string;
}

export interface SlidingWindow {
  targetTokens?: number;
}

export interface ContextWindowCompressionConfig {
  triggerTokens?: number;
  slidingWindow?: SlidingWindow;
}

export interface PrebuiltVoiceConfig {
  voiceName?: string;
}

export interface VoiceConfig {
  prebuiltVoiceConfig?: PrebuiltVoiceConfig;
}

export interface SpeakerVoiceConfig {
  speaker: string;
  voiceConfig: VoiceConfig;
}

export interface MultiSpeakerVoiceConfig {
  speakerVoiceConfigs: SpeakerVoiceConfig[];
}

export interface SingleSpeakerSpeechConfig extends BaseSpeechConfig {
  voiceConfig?: VoiceConfig;
  multiSpeakerVoiceConfig?: never;
}

export interface MultiSpeakerSpeechConfig extends BaseSpeechConfig {
  voiceConfig?: never;
  multiSpeakerVoiceConfig?: MultiSpeakerVoiceConfig;
}

export type SpeechConfig = SingleSpeakerSpeechConfig | MultiSpeakerSpeechConfig;

export interface Transcription {
  text?: string;
}

export interface SessionResumptionConfig {
  handle?: string;
}

export interface StartAudioConversationOptions {
  functionCallingHandler?: (functionCalls: FunctionCall[]) => Promise<FunctionResponse>;
}

export interface LiveGenerationConfig {
  speechConfig?: SpeechConfig;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseModalities?: ResponseModality[];
  inputAudioTranscription?: AudioTranscriptionConfig;
  outputAudioTranscription?: AudioTranscriptionConfig;
  contextWindowCompression?: ContextWindowCompressionConfig;
}

export interface LiveModelParams {
  model: string;
  generationConfig?: LiveGenerationConfig;
  tools?: Tool[];
  toolConfig?: ToolConfig;
  systemInstruction?: string | Part | Content;
}

export interface LiveServerContent {
  type: 'serverContent';
  modelTurn?: Content;
  turnComplete?: boolean;
  interrupted?: boolean;
  inputTranscription?: Transcription;
  outputTranscription?: Transcription;
}

export interface LiveServerGoingAwayNotice {
  type: 'goingAwayNotice';
  timeLeft: number;
}

export interface LiveServerToolCall {
  type: 'toolCall';
  functionCalls: FunctionCall[];
}

export interface LiveServerToolCallCancellation {
  type: 'toolCallCancellation';
  functionIds: string[];
}

export interface LiveSessionResumptionUpdate {
  type: 'sessionResumptionUpdate';
  newHandle?: string;
  resumable?: boolean;
  lastConsumedClientMessageIndex?: number;
}

export interface LiveSession {
  isClosed: boolean;
  inConversation: boolean;
  connectionPromise: Promise<void>;
  resumeSession(sessionResumption?: SessionResumptionConfig): Promise<void>;
  send(request: string | Array<string | Part>, turnComplete?: boolean): Promise<void>;
  sendTextRealtime(text: string): Promise<void>;
  sendAudioRealtime(blob: GenerativeContentBlob): Promise<void>;
  sendVideoRealtime(blob: GenerativeContentBlob): Promise<void>;
  sendFunctionResponses(functionResponses: FunctionResponse[]): Promise<void>;
  receive(): AsyncGenerator<
    | LiveServerContent
    | LiveServerToolCall
    | LiveServerToolCallCancellation
    | LiveServerGoingAwayNotice
    | LiveSessionResumptionUpdate
  >;
  close(): Promise<void>;
  sendMediaChunks(mediaChunks: GenerativeContentBlob[]): Promise<void>;
  sendMediaStream(mediaChunkStream: ReadableStream<GenerativeContentBlob>): Promise<void>;
}

export interface LiveGenerativeModel {
  readonly model: string;
  generationConfig: LiveGenerationConfig;
  tools?: Tool[];
  toolConfig?: ToolConfig;
  systemInstruction?: Content;
  connect(sessionResumption?: SessionResumptionConfig): Promise<LiveSession>;
}
