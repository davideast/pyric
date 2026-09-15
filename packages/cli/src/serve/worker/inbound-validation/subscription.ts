import { assertQueryStructure } from '../host/query-structure.js';
import { assertAiArguments } from './operation-arguments.js';
import { assertRtdbQuery } from './rtdb-query.js';
import { assertListenerOwners } from './listener-owners.js';
import { requireRecord, requireShape, requireString } from './fields.js';

/** Check target routing and adapter fields before retaining listener intent. */
export function assertSubscription(message: Record<string, unknown>): void {
  assertListenerOwners(message.owners);
  const target = message.target;
  const isNamedTarget = typeof target === 'string';
  if (isNamedTarget) {
    switch (target) {
      case 'authState': case 'idToken': case 'events':
      case 'messaging.foreground': case 'messaging.background': case 'presence':
        return;
      default:
        requireShape(false, 'target');
    }
  }
  requireRecord(target, 'target');
  switch (target.service) {
    case 'rtdb':
      requireString(target.path, 'target.path');
      assertRtdbQuery(target.query);
      return;
    case 'ai': {
      const isStream = target.op === 'streamGenerateContent';
      requireShape(isStream, 'target.op');
      assertAiArguments(message);
      return;
    }
    default:
      assertQueryStructure(target);
  }
}
