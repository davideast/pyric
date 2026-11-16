import { posix } from 'node:path';
import type { CompatibilityRow } from '../registry/types.ts';

const MOCK_BRIDGE_PACKAGE_PREFIXES = [
  'packages/flutter-client/',
  'packages/kt-client/',
  'packages/swift-client/',
] as const;

export function normalizeConformanceTestPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, '/');
  if (trimmed === '') return '';
  const normalized = posix.normalize(trimmed);
  if (normalized === '.') return '';
  if (normalized.startsWith('./')) return normalized.slice(2);
  return normalized;
}

export function isMockBridgeUnitTestPath(rawPath: string): boolean {
  const normalized = normalizeConformanceTestPath(rawPath);
  if (normalized === '') return false;
  return MOCK_BRIDGE_PACKAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function hasLiveHostConformanceEvidence(
  row: Pick<CompatibilityRow, 'hostConformanceTests'>,
): boolean {
  const hostTests = row.hostConformanceTests ?? [];
  return hostTests.some((rawPath) => {
    const normalized = normalizeConformanceTestPath(rawPath);
    return normalized !== '' && !isMockBridgeUnitTestPath(normalized);
  });
}
