import { describe, expect, test } from 'bun:test';
import { MESSAGING_SEND_PROBES } from '../../src/messaging-send-probe-catalog.ts';
import {
  probeWebpushLowercaseTtl,
  selectMessagingSendProbes,
} from '../../src/messaging-send-probes.ts';

describe('messaging-send-probes selection and lowercase webpush.headers.ttl probe', () => {
  test('selects all registered probes when no --probe flag is given', () => {
    const selected = selectMessagingSendProbes([]);
    expect(selected.length).toBe(MESSAGING_SEND_PROBES.length);
    expect(selected.map((p) => p.name)).toContain('messaging-send-webpush-lowercase-ttl');
  });

  test('filters to the requested probe via --probe and --probe= flags', () => {
    expect(
      selectMessagingSendProbes(['--probe', 'messaging-send-webpush-lowercase-ttl']).map((p) => p.name),
    ).toEqual(['messaging-send-webpush-lowercase-ttl']);
    expect(
      selectMessagingSendProbes(['--probe=messaging-send-topic-accepted']).map((p) => p.name),
    ).toEqual(['messaging-send-topic-accepted']);
  });

  test('rejects unknown --probe names cleanly', () => {
    expect(() => selectMessagingSendProbes(['--probe', 'messaging-send-unknown'])).toThrow(
      /Unknown messaging-send probe/,
    );
  });

  test('captures valid (60), negative (-1), and non-numeric (abc) lowercase webpush.headers.ttl outcomes deterministically', async () => {
    const calls: unknown[] = [];
    const fakeRawSend = async (payload: {
      validate_only: boolean;
      message: { webpush?: { headers?: Record<string, string> } };
    }): Promise<{ status: number; body: Record<string, unknown> }> => {
      calls.push(payload);
      const ttl = payload.message.webpush?.headers?.ttl;
      if (ttl === '60') {
        return {
          status: 200,
          body: { name: 'projects/digame-mas/messages/9876543210' },
        };
      }
      return {
        status: 400,
        body: {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: `Invalid ttl header: ${String(ttl)}`,
          },
        },
      };
    };

    const behavior = await probeWebpushLowercaseTtl(fakeRawSend, 'digame-mas');
    expect(calls).toHaveLength(6);
    expect(behavior).toEqual({
      validSixtySeconds: {
        headerKey: 'ttl',
        headerValue: '60',
        dryRunStatus: 200,
        dryRunAccepted: true,
        dryRunName: {
          matchesProjectsMessagesFormat: true,
          projectSegmentMatchesProject: true,
          messageIdIsNumericString: true,
        },
        realSendStatus: 200,
        realSendAccepted: true,
        realSendName: {
          matchesProjectsMessagesFormat: true,
          projectSegmentMatchesProject: true,
          messageIdIsNumericString: true,
        },
        dryRunMatchesRealSend: true,
      },
      negativeOne: {
        headerKey: 'ttl',
        headerValue: '-1',
        dryRunStatus: 400,
        dryRunAccepted: false,
        dryRunError: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'Invalid ttl header: -1',
        },
        realSendStatus: 400,
        realSendAccepted: false,
        realSendError: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'Invalid ttl header: -1',
        },
        dryRunMatchesRealSend: true,
      },
      nonNumericAbc: {
        headerKey: 'ttl',
        headerValue: 'abc',
        dryRunStatus: 400,
        dryRunAccepted: false,
        dryRunError: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'Invalid ttl header: abc',
        },
        realSendStatus: 400,
        realSendAccepted: false,
        realSendError: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'Invalid ttl header: abc',
        },
        dryRunMatchesRealSend: true,
      },
    });
  });
});
