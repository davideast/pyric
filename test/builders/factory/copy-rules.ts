/**
 * The copy rules from DESIGN.md section 4, judged one visible string at a
 * time. A string's kind decides which rules apply: every string gets the
 * phrase, dash and ellipsis rules; a button label must be sentence case and
 * start with a verb; a description or empty state has a word limit, and an
 * empty state is one sentence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type CopyKind = 'button' | 'empty-state' | 'description' | 'text';

export interface CopyOverrides {
  /** More verbs a button may start with. */
  verbs: string[];
  /** Whole button labels allowed as they are. */
  buttonLabels: string[];
  /** Words that keep their capital inside a button label. */
  properNouns: string[];
}

const overridesSchema = z.object({
  verbs: z.array(z.string()).default([]),
  buttonLabels: z.array(z.string()).default([]),
  properNouns: z.array(z.string()).default([]),
}).strict();

export const DEFAULT_OVERRIDES_FILE = fileURLToPath(new URL('./ui-rules/copy-overrides.json', import.meta.url));

export function readOverrides(path: string): CopyOverrides {
  return overridesSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function mergeOverrides(base: CopyOverrides, extra: CopyOverrides): CopyOverrides {
  return {
    verbs: [...base.verbs, ...extra.verbs],
    buttonLabels: [...base.buttonLabels, ...extra.buttonLabels],
    properNouns: [...base.properNouns, ...extra.properNouns],
  };
}

/** Verbs a button label may start with. "Continue", "Submit", "OK" and "Go" are left out on purpose. */
export const VERBS: readonly string[] = [
  'add', 'apply', 'approve', 'cancel', 'change', 'choose', 'clear', 'close', 'connect', 'copy', 'create', 'delete',
  'disconnect', 'discard', 'download', 'edit', 'export', 'filter', 'generate', 'hide', 'import', 'keep', 'listen',
  'load', 'lock', 'make', 'move', 'narrate', 'open', 'pause', 'pin', 'play', 'preview', 'publish', 'read', 'record',
  'redo', 'refresh', 'remove', 'rename', 'replace', 'reset', 'restore', 'retry', 'save', 'search', 'select', 'send',
  'share', 'show', 'sign', 'skip', 'sort', 'start', 'stop', 'try', 'undo', 'unlock', 'unpin', 'update', 'upload',
  'use', 'view',
];

/** DESIGN.md's "Never write" list, as patterns. */
const NEVER_WRITE: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /\b(welcome|hello|hi there|greetings)\b/i, name: 'a welcome or greeting' },
  { pattern: /\bhere you can\b/i, name: '"Here you can"' },
  { pattern: /\bthis page lets you\b/i, name: '"This page lets you"' },
  { pattern: /\beasily\b/i, name: '"easily"' },
  { pattern: /\bseamlessly\b/i, name: '"seamlessly"' },
  { pattern: /\bsimply\b/i, name: '"simply"' },
  { pattern: /\bjust\b/i, name: '"just"' },
  { pattern: /\bpowerful\b/i, name: '"powerful"' },
  { pattern: /\bmanage your\b/i, name: '"Manage your"' },
  { pattern: /\boptional ways to\b/i, name: '"Optional ways to"' },
];

/** Descriptions and empty states: one line. */
export const DESCRIPTION_WORD_LIMIT = 20;

const EM_DASH = /—/;
const ELLIPSIS = /…|\.\.\./;
const SENTENCE_END = /[.!?](?=\s|$)/g;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter((word) => word !== '');
}

function bareWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function isTitleCaseWord(word: string, properNouns: ReadonlySet<string>): boolean {
  const bare = bareWord(word);
  const startsUpper = /^\p{Lu}\p{Ll}/u.test(bare);
  return startsUpper && !properNouns.has(bare);
}

function buttonProblems(text: string, overrides: CopyOverrides): string[] {
  if (overrides.buttonLabels.includes(text.trim())) return [];
  const problems: string[] = [];
  const [first = '', ...rest] = words(text);
  const verbs = new Set([...VERBS, ...overrides.verbs.map((verb) => verb.toLowerCase())]);
  const startsWithVerb = verbs.has(bareWord(first).toLowerCase());
  if (!startsWithVerb) problems.push(`a button label starts with a verb that names its effect; "${bareWord(first)}" is not on the verb list`);
  const properNouns = new Set(overrides.properNouns);
  const titleCased = rest.filter((word) => isTitleCaseWord(word, properNouns));
  if (titleCased.length > 0) problems.push(`button labels are sentence case; "${titleCased.join(' ')}" is capitalized`);
  return problems;
}

function lengthProblems(text: string, kind: CopyKind): string[] {
  const problems: string[] = [];
  const count = words(text).length;
  if (count > DESCRIPTION_WORD_LIMIT) problems.push(`${count} words; a ${kind} is one line, at most ${DESCRIPTION_WORD_LIMIT} words`);
  const sentences = text.trim().match(SENTENCE_END)?.length ?? 0;
  const isLongEmptyState = kind === 'empty-state' && sentences > 1;
  if (isLongEmptyState) problems.push(`${sentences} sentences; an empty state is one sentence and one action`);
  return problems;
}

/** What is wrong with one string, as reasons; none when it passes. */
export function copyProblems(text: string, kind: CopyKind, overrides: CopyOverrides): string[] {
  const problems = NEVER_WRITE.filter(({ pattern }) => pattern.test(text)).map(({ name }) => `never write ${name}`);
  if (EM_DASH.test(text)) problems.push('no em dashes');
  if (ELLIPSIS.test(text)) problems.push('no ellipses; say what is happening and show a spinner');
  if (kind === 'button') problems.push(...buttonProblems(text, overrides));
  const hasLimit = kind === 'description' || kind === 'empty-state';
  if (hasLimit) problems.push(...lengthProblems(text, kind));
  return problems;
}
