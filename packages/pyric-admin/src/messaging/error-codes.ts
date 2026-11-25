/**
 * `firebase-admin/messaging` error codes and `FirebaseMessagingError`
 * (`lib/messaging/error.js`, v14.5.1).
 */
import { PrefixedFirebaseError, type ErrorInfo } from '../app/firebase-error.js';

export interface MessagingErrorCodeInfo {
  readonly code: string;
  readonly message: string;
}

export const MessagingErrorCode = {
  INVALID_ARGUMENT: 'invalid-argument',
  INVALID_RECIPIENT: 'invalid-recipient',
  INVALID_PAYLOAD: 'invalid-payload',
  INVALID_DATA_PAYLOAD_KEY: 'invalid-data-payload-key',
  PAYLOAD_SIZE_LIMIT_EXCEEDED: 'payload-size-limit-exceeded',
  INVALID_OPTIONS: 'invalid-options',
  INVALID_REGISTRATION_TOKEN: 'invalid-registration-token',
  REGISTRATION_TOKEN_NOT_REGISTERED: 'registration-token-not-registered',
  INSTALLATION_ID_NOT_REGISTERED: 'installation-id-not-registered',
  MISMATCHED_CREDENTIAL: 'mismatched-credential',
  INVALID_PACKAGE_NAME: 'invalid-package-name',
  DEVICE_MESSAGE_RATE_EXCEEDED: 'device-message-rate-exceeded',
  TOPICS_MESSAGE_RATE_EXCEEDED: 'topics-message-rate-exceeded',
  TOPICS_SUBSCRIPTION_RATE_EXCEEDED: 'topics-subscription-rate-exceeded',
  MESSAGE_RATE_EXCEEDED: 'message-rate-exceeded',
  THIRD_PARTY_AUTH_ERROR: 'third-party-auth-error',
  TOO_MANY_TOPICS: 'too-many-topics',
  AUTHENTICATION_ERROR: 'authentication-error',
  SERVER_UNAVAILABLE: 'server-unavailable',
  INTERNAL_ERROR: 'internal-error',
  UNKNOWN_ERROR: 'unknown-error',
} as const;

export type MessagingErrorCodeKey = keyof typeof MessagingErrorCode;

export const MESSAGING_CLIENT_ERROR_INFO: Record<MessagingErrorCodeKey, MessagingErrorCodeInfo> = {
  INVALID_ARGUMENT: {
    code: MessagingErrorCode.INVALID_ARGUMENT,
    message: 'Invalid argument provided.',
  },
  INVALID_RECIPIENT: {
    code: MessagingErrorCode.INVALID_RECIPIENT,
    message: 'Invalid message recipient provided.',
  },
  INVALID_PAYLOAD: {
    code: MessagingErrorCode.INVALID_PAYLOAD,
    message: 'Invalid message payload provided.',
  },
  INVALID_DATA_PAYLOAD_KEY: {
    code: MessagingErrorCode.INVALID_DATA_PAYLOAD_KEY,
    message:
      'The data message payload contains an invalid key. See the reference documentation ' +
      'for the DataMessagePayload type for restricted keys.',
  },
  PAYLOAD_SIZE_LIMIT_EXCEEDED: {
    code: MessagingErrorCode.PAYLOAD_SIZE_LIMIT_EXCEEDED,
    message:
      'The provided message payload exceeds the FCM size limits. See the error documentation ' +
      'for more details.',
  },
  INVALID_OPTIONS: {
    code: MessagingErrorCode.INVALID_OPTIONS,
    message: 'Invalid message options provided.',
  },
  INVALID_REGISTRATION_TOKEN: {
    code: MessagingErrorCode.INVALID_REGISTRATION_TOKEN,
    message:
      'Invalid registration token provided. Make sure it matches the registration token ' +
      'the client app receives from registering with FCM.',
  },
  REGISTRATION_TOKEN_NOT_REGISTERED: {
    code: MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    message:
      'The provided registration token is not registered. A previously valid registration ' +
      'token can be unregistered for a variety of reasons. See the error documentation for more ' +
      'details. Remove this registration token and stop using it to send messages.',
  },
  INSTALLATION_ID_NOT_REGISTERED: {
    code: MessagingErrorCode.INSTALLATION_ID_NOT_REGISTERED,
    message:
      'The provided installation ID is not registered. A previously valid installation ' +
      'ID can be unregistered for a variety of reasons. See the error documentation for more ' +
      'details. Remove this installation ID and stop using it to send messages.',
  },
  MISMATCHED_CREDENTIAL: {
    code: MessagingErrorCode.MISMATCHED_CREDENTIAL,
    message:
      'The credential used to authenticate this SDK does not have permission to send ' +
      'messages to the device corresponding to the provided registration token. Make sure the ' +
      'credential and registration token both belong to the same Firebase project.',
  },
  INVALID_PACKAGE_NAME: {
    code: MessagingErrorCode.INVALID_PACKAGE_NAME,
    message:
      'The message was addressed to a registration token whose package name does not match ' +
      'the provided "restrictedPackageName" option.',
  },
  DEVICE_MESSAGE_RATE_EXCEEDED: {
    code: MessagingErrorCode.DEVICE_MESSAGE_RATE_EXCEEDED,
    message:
      'The rate of messages to a particular device is too high. Reduce the number of ' +
      'messages sent to this device and do not immediately retry sending to this device.',
  },
  TOPICS_MESSAGE_RATE_EXCEEDED: {
    code: MessagingErrorCode.TOPICS_MESSAGE_RATE_EXCEEDED,
    message:
      'The rate of messages to subscribers to a particular topic is too high. Reduce the ' +
      'number of messages sent for this topic, and do not immediately retry sending to this topic.',
  },
  TOPICS_SUBSCRIPTION_RATE_EXCEEDED: {
    code: MessagingErrorCode.TOPICS_SUBSCRIPTION_RATE_EXCEEDED,
    message:
      'The rate of subscription management requests to a particular topic is too ' +
      'high. Reduce the number of requests sent for this topic, and do not immediately retry the ' +
      'request.',
  },
  MESSAGE_RATE_EXCEEDED: {
    code: MessagingErrorCode.MESSAGE_RATE_EXCEEDED,
    message: 'Sending limit exceeded for the message target.',
  },
  THIRD_PARTY_AUTH_ERROR: {
    code: MessagingErrorCode.THIRD_PARTY_AUTH_ERROR,
    message:
      'A message targeted to an iOS device could not be sent because the required APNs ' +
      'SSL certificate was not uploaded or has expired. Check the validity of your development ' +
      'and production certificates.',
  },
  TOO_MANY_TOPICS: {
    code: MessagingErrorCode.TOO_MANY_TOPICS,
    message:
      'The maximum number of topics the provided registration token can be subscribed to ' +
      'has been exceeded.',
  },
  AUTHENTICATION_ERROR: {
    code: MessagingErrorCode.AUTHENTICATION_ERROR,
    message:
      'An error occurred when trying to authenticate to the FCM servers. Make sure the ' +
      'credential used to authenticate this SDK has the proper permissions. See ' +
      'https://firebase.google.com/docs/admin/setup for setup instructions.',
  },
  SERVER_UNAVAILABLE: {
    code: MessagingErrorCode.SERVER_UNAVAILABLE,
    message:
      'The FCM server could not process the request in time. See the error documentation ' +
      'for more details.',
  },
  INTERNAL_ERROR: {
    code: MessagingErrorCode.INTERNAL_ERROR,
    message: 'An internal error has occurred. Please retry the request.',
  },
  UNKNOWN_ERROR: {
    code: MessagingErrorCode.UNKNOWN_ERROR,
    message: 'An unknown server error was returned.',
  },
};

export class FirebaseMessagingError extends PrefixedFirebaseError {
  constructor(info: ErrorInfo, message?: string) {
    let shortCode = info.code;
    if (shortCode.startsWith('messaging/')) {
      shortCode = shortCode.slice('messaging/'.length);
    }
    let resolvedMessage = info.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super('messaging', shortCode, resolvedMessage, {
      httpResponse: info.httpResponse,
      cause: info.cause,
    });
    this.name = 'FirebaseMessagingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
