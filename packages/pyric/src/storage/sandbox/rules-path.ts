import { RulesValue } from '../../rules/simulator/wrappers/base.js';

export class StoragePath extends RulesValue {
  readonly typeName = 'path';
  /** Names bound to segments; a Storage path value binds none. */
  readonly bindings: Readonly<Record<string, string>> = {};
  constructor(readonly path: string) {
    super();
  }
  /** The path's segments, which `path[i]` reads. */
  get segments(): string[] {
    return this.path.split('/').filter(Boolean);
  }
  valueOf(): number {
    return NaN;
  }
  toJSON(): unknown {
    return { __type: 'path', path: this.toString() };
  }
  equals(other: unknown): boolean {
    return (
      (other instanceof StoragePath || (other instanceof RulesValue && other.typeName === 'path')) &&
      String(other) === this.toString()
    );
  }
  toString(): string {
    return this.path.startsWith('/') ? this.path : `/${this.path}`;
  }
}
