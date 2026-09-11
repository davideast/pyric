/**
 * The stream's vocabulary is derived from the per-service records, not
 * restated. These tests pin the aggregate's shape so a service cannot join the
 * stream without declaring what it emits.
 */
import { describe, it, expect } from 'bun:test';
import {
  MUTATION_EVENT_SERVICES,
  SERVICE_EVENT_RECORDS,
} from '../../../src/sandbox/types/service-event-records.js';

describe('service event records', () => {
  it('keys every record by the service name the record itself declares', () => {
    for (const [key, record] of Object.entries(SERVICE_EVENT_RECORDS)) {
      expect(record.service).toBe(key);
    }
  });

  it('declares every service that emits the cross-service mutation envelope', () => {
    expect([...MUTATION_EVENT_SERVICES].sort()).toEqual([
      'ai',
      'auth',
      'functions',
      'messaging',
      'rtdb',
      'storage',
    ]);
  });

  it('gives every service at least one operation and a named target', () => {
    for (const record of Object.values(SERVICE_EVENT_RECORDS)) {
      expect(record.operations.length).toBeGreaterThan(0);
      expect(new Set(record.operations).size).toBe(record.operations.length);
      expect(record.target.name.length).toBeGreaterThan(0);
      expect(record.target.description.length).toBeGreaterThan(0);
    }
  });
});
