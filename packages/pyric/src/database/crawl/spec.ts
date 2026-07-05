import { z } from 'zod';
import type { RtdbHost } from '../host.js';

export type CrawlOptions = {
  path?: string;
  maxDepth?: number;
  maxChildren?: number;
  maxConcurrency?: number;
};

export const CRAWL_DEFAULTS: Required<CrawlOptions> = {
  path: '/',
  maxDepth: 10,
  maxChildren: 100,
  maxConcurrency: 5,
};

export type StructureNode = {
  path: string;
  childCount: number;
  truncated: boolean;
  children: StructureNode[];
  schema: Record<string, string>;
  valueType?: string;  // "string" | "number" | "boolean" | "null" — set when this node IS a leaf primitive
};

export const CrawlErrorCode = z.enum([
  'CRAWL_FAILED',
  'PERMISSION_DENIED',
]);

export type CrawlStructureResult =
  | { success: true; data: StructureNode }
  | { success: false; error: { code: z.infer<typeof CrawlErrorCode>; message: string; recoverable: boolean } };

export interface CrawlStructureSpec {
  execute(host: RtdbHost, options?: CrawlOptions): Promise<CrawlStructureResult>;
}
