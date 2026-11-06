/**
 * An observed call keeps the SDK export the app called as its `method`.
 * Readers that compare it with sandbox rows map it to the one method name
 * both modes share.
 */
import { describe, expect, it } from 'bun:test';
import type { ObservedCallService } from '../../src/sandbox/index.js';
import { observedMethod, type ObservedMethod } from '../../src/sandbox/internal/index.js';

type Row = readonly [ObservedCallService, string, ObservedMethod];

const MAPPED: readonly Row[] = [
  ['firestore', 'getDoc', 'get'],
  ['firestore', 'getDocFromServer', 'get'],
  ['firestore', 'getDocFromCache', 'get'],
  ['firestore', 'getDocs', 'list'],
  ['firestore', 'getDocsFromServer', 'list'],
  ['firestore', 'getDocsFromCache', 'list'],
  ['firestore', 'setDoc', 'set'],
  ['firestore', 'updateDoc', 'update'],
  ['firestore', 'deleteDoc', 'delete'],
  ['firestore', 'addDoc', 'create'],
  ['rtdb', 'get', 'get'],
  ['rtdb', 'set', 'set'],
  ['rtdb', 'setWithPriority', 'set'],
  ['rtdb', 'update', 'update'],
  ['rtdb', 'remove', 'delete'],
  ['rtdb', 'push', 'create'],
  ['storage', 'uploadBytes', 'create'],
  ['storage', 'uploadString', 'create'],
  ['storage', 'uploadBytesResumable', 'create'],
  ['storage', 'getDownloadURL', 'get'],
  ['storage', 'getBytes', 'get'],
  ['storage', 'getBlob', 'get'],
  ['storage', 'getStream', 'get'],
  ['storage', 'getMetadata', 'get'],
  ['storage', 'updateMetadata', 'update'],
  ['storage', 'list', 'list'],
  ['storage', 'listAll', 'list'],
  ['storage', 'deleteObject', 'delete'],
];

const UNMAPPED: readonly (readonly [ObservedCallService, string])[] = [
  ['firestore', 'runTransaction'],
  ['firestore', 'getCountFromServer'],
  ['firestore', 'onSnapshot'],
  ['rtdb', 'onValue'],
  ['rtdb', 'runTransaction'],
  ['auth', 'signInWithEmailAndPassword'],
  ['ai', 'generateContent'],
  ['messaging', 'getToken'],
  ['storage', 'get'],
  ['rtdb', 'getDoc'],
];

describe('observedMethod', () => {
  it.each(MAPPED)('maps %s %s to %s', (service, method, expected) => {
    expect(observedMethod(service, method)).toBe(expected);
  });

  it.each(UNMAPPED)('maps %s %s to null', (service, method) => {
    expect(observedMethod(service, method)).toBeNull();
  });

  it('reads an inherited object key as no export', () => {
    expect(observedMethod('firestore', 'toString')).toBeNull();
    expect(observedMethod('rtdb', 'constructor')).toBeNull();
  });
});
