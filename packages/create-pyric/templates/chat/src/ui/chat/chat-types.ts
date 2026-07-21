import type { ChatMode } from '../../chat-mode';

export type UiMessageRole = 'user' | 'assistant' | 'system';

export type UiMessage = {
  id: string;
  role: UiMessageRole;
  text: string;
  createdAt?: Date;
  status?: 'sending' | 'streaming' | 'complete' | 'error';
  clientMessageId?: string;
  thoughts?: string;
  replyToClientMessageId?: string;
  toolCalls?: UiToolCall[];
  usage?: UiUsage;
};

export type UiConversation = {
  id: string;
  title: string;
  updatedAt?: Date;
};

export type UiUser = {
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
};

export type UiPresence = {
  uid: string;
  displayName: string | null;
};

export type UiNotification = {
  title: string;
  body: string | null;
};

export type UiFinishReason = 'stop' | 'length' | 'safety' | 'error' | null;

export type UiUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
};

export type UiToolCall = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'complete' | 'error';
  summary?: string;
};

export type ChatPageServices = {
  auth: {
    currentUser(): UiUser | null;
    observe(callback: (user: UiUser | null) => void): () => void;
    signIn(): Promise<UiUser>;
    signOut(): Promise<void>;
  };
  conversations: {
    list(): Promise<UiConversation[]>;
    create(input?: { title?: string }): Promise<string>;
    delete(id: string): Promise<void>;
    observe(id: string, callback: (conversation: UiConversation) => void): () => void;
    observeList(callback: (conversations: UiConversation[]) => void): () => void;
  };
  messages: {
    list(conversationId: string): Promise<UiMessage[]>;
    appendUserMessage(input: { conversationId: string; text: string; clientMessageId: string }): Promise<string>;
    appendAssistantMessage(input: { conversationId: string; text: string; clientMessageId: string; thoughts?: string; model?: string; finishReason?: UiFinishReason; inputTokenCount?: number | null; outputTokenCount?: number | null }): Promise<string>;
    observeRecent(conversationId: string, callback: (messages: UiMessage[]) => void): () => void;
  };
  ai: {
    stream(
      input: { conversationId: string; messages: Pick<UiMessage, 'role' | 'text'>[]; mode?: ChatMode; signal?: AbortSignal },
      onChunk: (chunk: string) => void,
      onThought?: (thought: string) => void,
      onTool?: (tool: UiToolCall) => void,
      onUsage?: (usage: UiUsage) => void,
      onWorkspaceChanged?: () => void,
    ): Promise<{ text: string; thoughts?: string; model?: string; finishReason?: UiFinishReason; inputTokenCount?: number | null; outputTokenCount?: number | null; usage?: UiUsage }>;
  };
  presence: {
    observe(callback: (online: UiPresence[]) => void): () => void;
  };
  notifications: {
    enable(onMessage: (message: UiNotification) => void): Promise<boolean>;
    showEnabledConfirmation(): Promise<void>;
  };
  workspace: {
    readAppSource(): Promise<string>;
    previewApp(source: string, hostModules: { react: Record<string, unknown>; jsxRuntime: Record<string, unknown>; jsxDevRuntime: Record<string, unknown> }): Promise<{ ok: true; component: unknown } | { ok: false; diagnostics: Array<{ message: string; line?: number; column?: number }> }>;
    subscribe(callback: () => void): () => void;
  };
};
