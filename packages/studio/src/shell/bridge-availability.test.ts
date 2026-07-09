/**
 * The shell's MCP chip must reflect bridge AVAILABILITY (endpoint live + a
 * sandbox peer from ANY tab), not Studio's own peer-slot registration —
 * another tab winning the last-connection-wins slot must not hide the chip.
 */
import { describe, expect, it } from 'bun:test';
import {
  availabilityFromProbe,
  probeFromResponse,
} from './bridge-availability.js';

describe('availabilityFromProbe', () => {
  it('is available when the bridge answers and a sandbox peer is connected', () => {
    expect(availabilityFromProbe({ kind: 'json', sandboxConnected: true })).toBe('available');
  });

  it('is idle when the bridge answers but no peer is connected', () => {
    expect(availabilityFromProbe({ kind: 'json', sandboxConnected: false })).toBe('idle');
  });

  it('is absent when there is no bridge endpoint', () => {
    expect(availabilityFromProbe({ kind: 'absent' })).toBe('absent');
  });
});

describe('probeFromResponse', () => {
  it('accepts the health shape', () => {
    expect(probeFromResponse(200, { status: 'ok', sandboxConnected: true })).toEqual({
      kind: 'json',
      sandboxConnected: true,
    });
    expect(probeFromResponse(200, { sandboxConnected: false })).toEqual({
      kind: 'json',
      sandboxConnected: false,
    });
  });

  it('treats non-200s as absent (serve without --bridge 404s here)', () => {
    expect(probeFromResponse(404, 'not found')).toEqual({ kind: 'absent' });
    expect(probeFromResponse(500, {})).toEqual({ kind: 'absent' });
  });

  it('treats non-health JSON as absent (an SPA fallback answering HTML/JSON)', () => {
    expect(probeFromResponse(200, {})).toEqual({ kind: 'absent' });
    expect(probeFromResponse(200, { sandboxConnected: 'yes' })).toEqual({ kind: 'absent' });
    expect(probeFromResponse(200, null)).toEqual({ kind: 'absent' });
    expect(probeFromResponse(200, 'ok')).toEqual({ kind: 'absent' });
  });
});
