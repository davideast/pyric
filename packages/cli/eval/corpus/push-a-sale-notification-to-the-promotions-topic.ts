import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'push-a-sale-notification-to-the-promotions-topic',
  prompt:
    "Send a push notification to everyone subscribed to the 'promotions' topic. Title it 'Flash Sale' and say 'Twenty percent off for the next hour.' in the body.",
  seed: {},
  acceptedFirstOperations: ['send_messaging_message'],
  assert: (state) => {
    const sent = state.calls.find((c) => c.operation === 'send_messaging_message' && c.ok);
    if (sent === undefined) return 'no send_messaging_message call ever succeeded';
    return true;
  },
  tags: ['messaging', 'write'],
};

export default task;
