import { RulesValue } from '../../rules/simulator/wrappers/base.js';

export class StoragePath extends RulesValue {
  readonly typeName = 'path';
  constructor(readonly path: string) {
    super();
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
