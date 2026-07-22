import type { Expression } from '../grammar/FirestoreAST.js';
import { assembleExpression } from '../grammar/FirestoreAssembler.js';

/** One entry in a per-rule expression trace, emitted in evaluation order. */
export interface ExprTraceEntry {
  source: string;
  kind: Expression['type'];
  parent: number | null;
  value?: unknown;
  skipped?: boolean;
  error?: string;
  letBinding?: { name: string };
  inlinedFrom?: { name: string };
}

/** Records the flat, parent-indexed trace of an expression evaluation. */
export class TraceRecorder {
  readonly entries: ExprTraceEntry[] = [];
  private parents: number[] = [];
  private frames: string[] = [];

  capture<T>(expr: Expression, fn: () => T): T {
    const index = this.entries.length;
    const parent = this.parents.length > 0 ? this.parents[this.parents.length - 1] : null;
    const entry: ExprTraceEntry = { source: assembleExpression(expr), kind: expr.type, parent };
    this.stampFrame(entry);
    this.entries.push(entry);
    this.parents.push(index);
    try {
      const value = fn();
      this.entries[index].value = value;
      return value;
    } catch (error) {
      this.entries[index].error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.parents.pop();
    }
  }

  skip(expr: Expression): void {
    const parent = this.parents.length > 0 ? this.parents[this.parents.length - 1] : null;
    const entry: ExprTraceEntry = {
      source: assembleExpression(expr),
      kind: expr.type,
      parent,
      skipped: true,
    };
    this.stampFrame(entry);
    this.entries.push(entry);
  }

  enterFrame(name: string): void {
    this.frames.push(name);
  }

  exitFrame(): void {
    this.frames.pop();
  }

  markEntryAsLetBinding(index: number, name: string): void {
    if (index < 0 || index >= this.entries.length) return;
    this.entries[index].letBinding = { name };
  }

  private stampFrame(entry: ExprTraceEntry): void {
    if (this.frames.length === 0) return;
    entry.inlinedFrom = { name: this.frames[this.frames.length - 1] };
  }
}
