import type { EvalTask } from '../types.js';

const TOKEN = 'digest-reader-07:APA91bDigestTestSuffix';

const task: EvalTask = {
  id: 'unsubscribe-a-device-from-the-daily-digest',
  prompt:
    "Device token 'digest-reader-07:APA91bDigestTestSuffix' is subscribed to the 'daily-digest' topic and wants out. Unsubscribe it, then confirm it no longer shows daily-digest among its topics.",
  seed: {},
  acceptedFirstOperations: ['subscribe_messaging_topic', 'unsubscribe_messaging_topic'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'unsubscribe_messaging_topic' && c.ok)) {
      return 'no unsubscribe_messaging_topic call ever succeeded';
    }
    const listed = state.calls.find((c) => c.operation === 'list_messaging_tokens' && c.ok);
    if (listed === undefined) return 'no list_messaging_tokens call ever succeeded';
    const data = listed.data as { tokens?: Array<{ token: string; topics: string[] }> };
    const entry = data.tokens?.find((candidate) => candidate.token === TOKEN);
    if (entry !== undefined && entry.topics.includes('daily-digest')) {
      return 'daily-digest still showed up for the token after the unsubscribe';
    }
    return true;
  },
  tags: ['messaging', 'write', 'multi-step'],
};

export default task;
