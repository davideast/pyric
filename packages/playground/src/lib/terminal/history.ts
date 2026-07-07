/**
 * localStorage-backed command history for the terminal. Capped at
 * MAX_ENTRIES; reads tolerate corruption (parse error → empty list).
 *
 * Why localStorage and not the OPFS VFS: history is a per-browser
 * UX concern (recall the last thing _you_ typed), not part of the
 * versioned workspace. Storing under /workspace/.history would make
 * it noise in git status and leak between users on a shared sync.
 */

const STORAGE_KEY = 'pyric:terminal:history';
const MAX_ENTRIES = 500;

function safeRead(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function safeWrite(entries: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage quota / disabled — non-fatal, just lose persistence.
  }
}

export class CommandHistory {
  private entries: string[] = [];

  constructor() {
    this.entries = safeRead();
  }

  /** Append a non-empty entry. Collapses adjacent duplicates. */
  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }
    safeWrite(this.entries);
  }

  /** Entries in original (oldest-first) order. */
  all(): readonly string[] {
    return this.entries;
  }

  /** Reverse iteration — what ↑ navigation walks. */
  size(): number {
    return this.entries.length;
  }

  at(index: number): string | undefined {
    return this.entries[index];
  }

  clear(): void {
    this.entries = [];
    safeWrite(this.entries);
  }
}
