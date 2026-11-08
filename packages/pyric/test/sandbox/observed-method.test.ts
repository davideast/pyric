/**
 * An observed call keeps the SDK export the app called as its `method`.
 * Readers that compare it with sandbox rows map it to the one method name
 * both modes share.
 */
import { describe, expect, it } from 'bun:test';
import type { ObservedCallService } from '../../src/sandbox/index.js';
import {
  isObservedRtdbListener,
  observedMethod,
  rtdbRulesMethod,
  rulesOperation,
  type ObservedMethod,
} from '../../src/sandbox/internal/index.js';

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

describe('rulesOperation', () => {
  it("reads a live call's SDK method as the rules operation the local evaluation ran", () => {
    expect(rulesOperation('firestore', 'getDoc')).toBe('get');
    expect(rulesOperation('firestore', 'getDocs')).toBe('list');
    expect(rulesOperation('firestore', 'setDoc')).toBe('create');
    expect(rulesOperation('firestore', 'updateDoc')).toBe('update');
    expect(rulesOperation('firestore', 'deleteDoc')).toBe('delete');
  });

  it("reads an RTDB call as the sandbox's write plane names it", () => {
    expect(rulesOperation('rtdb', 'get')).toBe('get');
    expect(rulesOperation('rtdb', 'onValue')).toBe('listen');
    expect(rulesOperation('rtdb', 'onChildAdded')).toBe('listen');
    expect(rulesOperation('rtdb', 'onChildChanged')).toBe('listen');
    expect(rulesOperation('rtdb', 'onChildRemoved')).toBe('listen');
    expect(rulesOperation('rtdb', 'onChildMoved')).toBe('listen');
    expect(rulesOperation('rtdb', 'set')).toBe('set');
    expect(rulesOperation('rtdb', 'setWithPriority')).toBe('set');
    expect(rulesOperation('rtdb', 'setPriority')).toBe('setPriority');
    expect(rulesOperation('rtdb', 'push')).toBe('set');
    expect(rulesOperation('rtdb', 'update')).toBe('update');
    expect(rulesOperation('rtdb', 'remove')).toBe('remove');
    expect(rulesOperation('rtdb', 'toString')).toBe('toString');
  });

  it('recognizes RTDB client listener exports without turning observedMethod non-null', () => {
    for (const listener of ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved']) {
      expect(isObservedRtdbListener(listener)).toBe(true);
      expect(observedMethod('rtdb', listener)).toBeNull();
    }
    expect(isObservedRtdbListener('get')).toBe(false);
    expect(isObservedRtdbListener('Query.on')).toBe(false);
  });

  it('names the rules request an RTDB export makes', () => {
    expect(rtdbRulesMethod('get')).toBe('get');
    expect(rtdbRulesMethod('onValue')).toBe('get');
    expect(rtdbRulesMethod('onChildMoved')).toBe('get');
    expect(rtdbRulesMethod('set')).toBe('set');
    expect(rtdbRulesMethod('setPriority')).toBe('set');
    expect(rtdbRulesMethod('push')).toBe('create');
    expect(rtdbRulesMethod('remove')).toBe('delete');
    expect(rtdbRulesMethod('runTransaction')).toBeNull();
    expect(rtdbRulesMethod('onDisconnect.set')).toBeNull();
  });

  it('reads a Storage call as observedMethod does', () => {
    expect(rulesOperation('storage', 'uploadBytes')).toBe('create');
    expect(rulesOperation('storage', 'deleteObject')).toBe('delete');
  });

  it('leaves a method with no rules operation as it is', () => {
    expect(rulesOperation('firestore', 'get')).toBe('get');
    expect(rulesOperation('auth', 'signInAnonymously')).toBe('signInAnonymously');
    expect(rulesOperation(undefined, 'getDoc')).toBe('getDoc');
    expect(rulesOperation('constructor', 'getDoc')).toBe('getDoc');
  });
});
