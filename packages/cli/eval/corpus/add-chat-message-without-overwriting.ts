import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'add-chat-message-without-overwriting',
  prompt:
    "Add a chat message saying 'welcome' under chatrooms/lobby/messages in the realtime database. Don't touch the messages that are already there.",
  seed: {
    database: {
      chatrooms: { lobby: { messages: { m1: { text: 'hi' } } } },
    },
  },
  acceptedFirstOperations: ['push_database_value'],
  assert: (state) => {
    const messages = state.database.get('chatrooms/lobby/messages');
    if (messages === null || typeof messages !== 'object') return 'the messages node is gone';
    const values = Object.values(messages as Record<string, unknown>);
    if (values.length < 2) return 'no new message was added';
    const kept = values.some((entry) => (entry as { text?: string }).text === 'hi');
    if (!kept) return 'the existing message was overwritten';
    const added = values.some((entry) => (entry as { text?: string }).text === 'welcome');
    if (!added) return 'no message with the requested text was written';
    return true;
  },
  tags: ['database', 'write'],
};

export default task;
