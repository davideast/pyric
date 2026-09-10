import type { EvalTask } from '../types.js';

const TOKEN = 'weather-app-device-01:APA91bWeatherTestSuffix';

const task: EvalTask = {
  id: 'sign-a-device-up-for-weather-alerts',
  prompt:
    "Subscribe device token 'weather-app-device-01:APA91bWeatherTestSuffix' to the 'weather-alerts' topic, then tell me every device token the sandbox knows about and what topics each one is subscribed to.",
  seed: {},
  acceptedFirstOperations: ['subscribe_messaging_topic'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'subscribe_messaging_topic' && c.ok)) {
      return 'no subscribe_messaging_topic call ever succeeded';
    }
    const listed = state.calls.find((c) => c.operation === 'list_messaging_tokens' && c.ok);
    if (listed === undefined) return 'no list_messaging_tokens call ever succeeded';
    const data = listed.data as { tokens?: Array<{ token: string; topics: string[] }> };
    const entry = data.tokens?.find((candidate) => candidate.token === TOKEN);
    if (entry === undefined) return `${TOKEN} was not in the listed tokens`;
    if (!entry.topics.includes('weather-alerts')) {
      return `${TOKEN} was not subscribed to weather-alerts in the read-back`;
    }
    return true;
  },
  tags: ['messaging', 'write', 'multi-step'],
};

export default task;
