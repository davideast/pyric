/**
 * Admin-SDK `FieldValue` facade (`@google-cloud/firestore` argument-count
 * parity over `pyric/sandbox/admin-compat` sentinels).
 */

import {
  FieldValue as CompatFieldValue,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-compat';

export class FieldValue {
  static serverTimestamp(): FieldValueSentinel {
    return CompatFieldValue.serverTimestamp();
  }

  static increment(...args: [n: number]): FieldValueSentinel {
    if (args.length < 1) {
      throw new Error('Function "FieldValue.increment()" requires at least 1 argument.');
    }
    return CompatFieldValue.increment(args[0]);
  }

  static arrayUnion(...elements: unknown[]): FieldValueSentinel {
    if (elements.length < 1) {
      throw new Error('Function "FieldValue.arrayUnion()" requires at least 1 argument.');
    }
    return CompatFieldValue.arrayUnion(...elements);
  }

  static arrayRemove(...elements: unknown[]): FieldValueSentinel {
    if (elements.length < 1) {
      throw new Error('Function "FieldValue.arrayRemove()" requires at least 1 argument.');
    }
    return CompatFieldValue.arrayRemove(...elements);
  }

  static delete(): FieldValueSentinel {
    return CompatFieldValue.delete();
  }
}
