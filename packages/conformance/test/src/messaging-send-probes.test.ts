import { describe, expect, test } from 'bun:test';
import { MESSAGING_SEND_PROBES } from '../../src/messaging-send-probe-catalog.ts';
import {
  assertFcmProbeHttpStatus,
  nameFacts,
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
        let mintedName = 'projects/digame-mas/messages/9876543210';
        if (payload.validate_only) {
          mintedName = 'projects/digame-mas/messages/-4829104829104829104';
        }
        return {
          status: 200,
          body: { name: mintedName },
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
        },
        realSendStatus: 200,
        realSendAccepted: true,
        realSendName: {
          matchesProjectsMessagesFormat: true,
          projectSegmentMatchesProject: true,
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

  test('throws on HTTP 401, 403 PERMISSION_DENIED, and 5xx so IAM/server errors never poison observations', () => {
    expect(() => assertFcmProbeHttpStatus(200, { name: 'projects/p/messages/1' })).not.toThrow();
    expect(() =>
      assertFcmProbeHttpStatus(400, { error: { code: 400, status: 'INVALID_ARGUMENT' } }),
    ).not.toThrow();
    expect(() =>
      assertFcmProbeHttpStatus(404, { error: { code: 404, status: 'NOT_FOUND' } }),
    ).not.toThrow();

    expect(() =>
      assertFcmProbeHttpStatus(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }),
    ).toThrow(/FCM probe HTTP 401 infrastructure\/IAM failure/);
    expect(() =>
      assertFcmProbeHttpStatus(403, {
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          message: "Permission 'cloudmessaging.messages.create' denied on resource '//cloudresourcemanager.googleapis.com/projects/digame-mas'",
        },
      }),
    ).toThrow(/cloudmessaging\.messages\.create/);
    expect(() =>
      assertFcmProbeHttpStatus(503, { error: { code: 503, status: 'UNAVAILABLE' } }),
    ).toThrow(/FCM probe HTTP 503 infrastructure\/IAM failure/);
  });

  test('extracts stable resource-name facts across unsigned, negative-integer, and opaque message ids', () => {
    expect(nameFacts('projects/demo-project/messages/9876543210', 'demo-project')).toEqual({
      matchesProjectsMessagesFormat: true,
      projectSegmentMatchesProject: true,
    });
    expect(nameFacts('projects/demo-project/messages/-4829104829104829104', 'demo-project')).toEqual({
      matchesProjectsMessagesFormat: true,
      projectSegmentMatchesProject: true,
    });
    expect(
      nameFacts('projects/demo-project/messages/0:1700000000000000%abcd1234', 'demo-project'),
    ).toEqual({
      matchesProjectsMessagesFormat: true,
      projectSegmentMatchesProject: true,
    });
    expect(nameFacts('projects/other-project/messages/9876543210', 'demo-project')).toEqual({
      matchesProjectsMessagesFormat: true,
      projectSegmentMatchesProject: false,
    });
    expect(nameFacts('projects/demo-project/messages/', 'demo-project')).toEqual({
      matchesProjectsMessagesFormat: false,
      projectSegmentMatchesProject: false,
    });
    expect(nameFacts('projects/demo-project/messages/extra/segment', 'demo-project')).toEqual({
      matchesProjectsMessagesFormat: false,
      projectSegmentMatchesProject: false,
    });
  });
});
