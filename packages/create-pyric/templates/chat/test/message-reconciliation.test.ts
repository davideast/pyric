import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileMessages } from '../src/ui/chat/message-reconciliation.ts';
import type { UiMessage } from '../src/ui/chat/chat-types.ts';

test('does not duplicate a persisted assistant when Firestore publishes again', () => {
  const persistedAssistant: UiMessage = {
    id: 'OK6MzPx25jG9GY9FwRA3',
    role: 'assistant',
    text: 'Persisted reply',
    status: 'complete',
    clientMessageId: 'assistant-client-message-1',
  };

  const firstSnapshot = reconcileMessages([persistedAssistant], []);
  const secondSnapshot = reconcileMessages([persistedAssistant], firstSnapshot);

  assert.deepEqual(secondSnapshot.map((message) => message.id), ['OK6MzPx25jG9GY9FwRA3']);
});

test('keeps a streaming assistant until its persisted replacement arrives', () => {
  const user: UiMessage = {
    id: 'server-user-1',
    role: 'user',
    text: 'Hello',
    status: 'complete',
    clientMessageId: 'client-message-1',
  };
  const streamingAssistant: UiMessage = {
    id: 'assistant-client-message-1',
    role: 'assistant',
    text: 'Streaming',
    status: 'streaming',
    replyToClientMessageId: 'client-message-1',
  };

  const whileStreaming = reconcileMessages([user], [user, streamingAssistant]);
  assert.deepEqual(whileStreaming.map((message) => message.id), [
    'server-user-1',
    'assistant-client-message-1',
  ]);

  const persistedAssistant: UiMessage = {
    id: 'server-assistant-1',
    role: 'assistant',
    text: 'Complete',
    status: 'complete',
    clientMessageId: 'assistant-client-message-1',
  };
  const afterPersistence = reconcileMessages(
    [user, persistedAssistant],
    whileStreaming,
  );
  assert.deepEqual(afterPersistence.map((message) => message.id), [
    'server-user-1',
    'server-assistant-1',
  ]);
});
