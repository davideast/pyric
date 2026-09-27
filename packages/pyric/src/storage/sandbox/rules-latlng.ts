import { RulesValue } from '../../rules/simulator/wrappers/base.js';

export class StorageLatLng extends RulesValue {
  readonly typeName = 'latlng';
  constructor(readonly latitude: number, readonly longitude: number) {
    super();
  }
  valueOf(): number {
    return NaN;
  }
  toJSON(): unknown {
    return { __type: 'latlng', latitude: this.latitude, longitude: this.longitude };
  }
  override field(name: string): unknown {
    if (name === 'latitude') return this.latitude;
    if (name === 'longitude') return this.longitude;
    return null;
  }
  equals(other: unknown): boolean {
    return (
      (other instanceof StorageLatLng || (other instanceof RulesValue && other.typeName === 'latlng')) &&
      (other as any).latitude === this.latitude &&
      (other as any).longitude === this.longitude
    );
  }
  toString(): string {
    return `[${this.latitude}, ${this.longitude}]`;
  }
}
