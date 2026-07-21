import type { Expression } from '../grammar/FirestoreAST.js';
import type { RulesServiceName } from './stdlib-service-compatibility.js';

export type RulesReceiverType =
  | 'bytes'
  | 'boolean'
  | 'document'
  | 'duration'
  | 'latlng'
  | 'list'
  | 'map'
  | 'mapdiff'
  | 'namespace'
  | 'null'
  | 'number'
  | 'path'
  | 'set'
  | 'string'
  | 'timestamp'
  | 'unknown';

export function ambientReceiverType(
  service: RulesServiceName,
  provenance: string[] | 'unknown-ambient' | null,
): RulesReceiverType | null {
  if (!provenance || provenance === 'unknown-ambient') return null;
  const path = provenance.join('.');
  if (path === 'request.auth' || path === 'request.auth.token' ||
      path === 'request.resource' || path === 'resource' ||
      path === 'request.resource.data' || path === 'resource.data' ||
      path === 'request.query' || path === 'request.resource.metadata' ||
      path === 'resource.metadata') return 'map';
  if (path === 'request.auth.uid' || path === 'request.method' ||
      path === 'request.resource.contentType' || path === 'resource.contentType' ||
      service === 'firebase.storage' &&
        (path.startsWith('request.resource.metadata.') || path.startsWith('resource.metadata.'))) {
    return 'string';
  }
  if (path === 'request.path') return 'path';
  if (path === 'request.time' || path === 'resource.timeCreated' || path === 'resource.updated') {
    return 'timestamp';
  }
  if (['request.resource.size', 'resource.size', 'resource.generation', 'resource.metageneration']
    .includes(path)) return 'number';
  return null;
}

export function methodReturnType(expression: Expression): RulesReceiverType | null {
  if (expression.type !== 'methodCall') return null;
  if (expression.object.type === 'identifier') {
    if (expression.object.name === 'firestore') {
      if (expression.method === 'get') return 'document';
      if (expression.method === 'exists') return 'boolean';
    }
    if (expression.object.name === 'duration') return 'duration';
    if (expression.object.name === 'timestamp') return 'timestamp';
    if (expression.object.name === 'latlng') return 'latlng';
    if (expression.object.name === 'hashing') return 'bytes';
    if (expression.object.name === 'math') return 'number';
    if (expression.object.name === 'cast') {
      if (expression.method === 'string') return 'string';
      if (expression.method === 'path') return 'path';
      if (expression.method === 'int' || expression.method === 'float') return 'number';
    }
  }
  if (['lower', 'upper', 'trim', 'replace', 'join', 'toBase64', 'toHexString']
    .includes(expression.method)) return 'string';
  if (['matches', 'hasAny', 'hasAll', 'hasOnly'].includes(expression.method)) return 'boolean';
  if (['concat', 'removeAll', 'split', 'values'].includes(expression.method)) return 'list';
  if (['keys', 'toSet', 'addedKeys', 'removedKeys', 'changedKeys', 'affectedKeys',
    'unchangedKeys', 'difference', 'union', 'intersection'].includes(expression.method)) return 'set';
  if (expression.method === 'diff') return 'mapdiff';
  if (expression.method === 'get') return null;
  if (expression.method === 'toUtf8') return 'bytes';
  if (expression.method === 'date') return 'timestamp';
  if (['size', 'year', 'month', 'day', 'hours', 'minutes', 'seconds', 'nanos',
    'dayOfWeek', 'dayOfYear', 'toMillis', 'latitude', 'longitude', 'distance']
    .includes(expression.method)) return 'number';
  return null;
}
