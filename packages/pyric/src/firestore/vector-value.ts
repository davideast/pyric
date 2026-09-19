import { registerQueryValue } from './sandbox/query-value-registry.js';

export class VectorValue {
  private constructor(readonly _values: number[]) {
    registerQueryValue(this, Object.freeze({
      type: 'vector',
      values: Object.freeze(_values.slice()),
    }), () => new VectorValue(_values.slice()));
  }

  static create(values: number[]): VectorValue {
    const hasNonNumericComponent = !values.every((value) => typeof value === 'number');
    if (hasNonNumericComponent) {
      throw new TypeError('Vector values must be numbers.');
    }
    return new VectorValue(values.slice());
  }

  toArray(): number[] {
    return this._values.slice();
  }

  isEqual(other: VectorValue): boolean {
    const hasDifferentType = !(other instanceof VectorValue);
    if (hasDifferentType) return false;
    const theirs = other._values;
    return theirs !== undefined
      && this._values.length === theirs.length
      && this._values.every((value, index) => value === theirs[index]);
  }

  toJSON(): object {
    return {
      type: 'firestore/vectorValue/1.0',
      vectorValues: this.toArray(),
    };
  }

  static fromJSON(json: object): VectorValue {
    const value = json as { readonly type?: unknown; readonly vectorValues?: unknown };
    const hasUnexpectedMarker = value.type !== 'firestore/vectorValue/1.0';
    const isInvalidVectorJson = hasUnexpectedMarker
      || !Array.isArray(value.vectorValues)
      || !value.vectorValues.every((entry) => typeof entry === 'number');
    if (isInvalidVectorJson) {
      throw new TypeError('Invalid VectorValue JSON value.');
    }
    return VectorValue.create(value.vectorValues);
  }
}

export function vector(values: number[] = []): VectorValue {
  return VectorValue.create(values);
}
