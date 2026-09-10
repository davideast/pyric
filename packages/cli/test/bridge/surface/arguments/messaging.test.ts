/**
 * The `messaging` tool's argument vocabulary: the renames onto the nested
 * `message` fields, and the shapes of a message, a token list, and a topic.
 */
import { describe, expect, it } from 'bun:test';

import {
  messageArgument,
  RENAMES,
  TARGET_FIELDS,
  tokensArgument,
  topicArgument,
} from '../../../../src/bridge/surface/arguments/messaging.js';

describe('the renames', () => {
  it('maps a top-level target field onto its nested message field', () => {
    expect(RENAMES.token).toBe('message.token');
    expect(RENAMES.topic).toBe('message.topic');
    expect(RENAMES.condition).toBe('message.condition');
    expect(RENAMES.notification).toBe('message.notification');
    expect(RENAMES.data).toBe('message.data');
  });

  it('maps the FCM registration-token spellings onto message.token or tokens', () => {
    expect(RENAMES.registrationToken).toBe('message.token');
    expect(RENAMES.deviceToken).toBe('message.token');
    expect(RENAMES.registrationTokens).toBe('tokens');
    expect(RENAMES.deviceTokens).toBe('tokens');
  });
});

describe('TARGET_FIELDS', () => {
  it('names the three ways a message names its recipient', () => {
    expect([...TARGET_FIELDS]).toEqual(['token', 'topic', 'condition']);
  });
});

describe('messageArgument', () => {
  it('accepts a message naming any one target field, and each optional field', () => {
    expect(messageArgument.safeParse({ token: 'device-token' }).success).toBe(true);
    expect(messageArgument.safeParse({ topic: 'news' }).success).toBe(true);
    expect(messageArgument.safeParse({ condition: "'news' in topics" }).success).toBe(true);
    expect(
      messageArgument.safeParse({
        topic: 'news',
        notification: { title: 'Hi', body: 'There' },
        data: { k: 'v' },
      }).success,
    ).toBe(true);
  });

  it('accepts an empty object, leaving the exactly-one-target rule to validate()', () => {
    expect(messageArgument.safeParse({}).success).toBe(true);
  });

  it('refuses data whose values are not strings, the flat map FCM delivers', () => {
    expect(messageArgument.safeParse({ topic: 'news', data: { k: 1 } }).success).toBe(false);
  });
});

describe('tokensArgument and topicArgument', () => {
  it('requires tokens as a string array and topic as a string', () => {
    expect(tokensArgument.safeParse(['a', 'b']).success).toBe(true);
    expect(tokensArgument.safeParse('a').success).toBe(false);
    expect(topicArgument.safeParse('news').success).toBe(true);
    expect(topicArgument.safeParse(1).success).toBe(false);
  });
});
