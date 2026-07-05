import { describe, test, expect } from 'bun:test';
import { CRAWL_DEFAULTS, CrawlErrorCode } from '../../../src/database/crawl/spec.js';

describe('CRAWL_DEFAULTS', () => {
  test('has expected default values', () => {
    expect(CRAWL_DEFAULTS.path).toBe('/');
    expect(CRAWL_DEFAULTS.maxDepth).toBe(10);
    expect(CRAWL_DEFAULTS.maxChildren).toBe(100);
    expect(CRAWL_DEFAULTS.maxConcurrency).toBe(5);
  });
});

describe('CrawlErrorCode', () => {
  test('has exactly 2 values', () => {
    expect(CrawlErrorCode.options).toHaveLength(2);
  });

  test('contains CRAWL_FAILED and PERMISSION_DENIED', () => {
    expect(CrawlErrorCode.enum.CRAWL_FAILED).toBe('CRAWL_FAILED');
    expect(CrawlErrorCode.enum.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
  });
});
