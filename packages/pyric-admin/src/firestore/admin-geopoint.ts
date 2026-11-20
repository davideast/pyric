/**
 * `GeoPoint` value class for `pyric-admin/firestore` matching
 * `@google-cloud/firestore` coordinate validation and equality semantics.
 */

function validateCoordinate(name: 'latitude' | 'longitude', value: number, min: number, max: number): void {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Value for argument "${name}" is not a valid number.`);
  }
  if (value < min || value > max) {
    throw new Error(
      `Value for argument "${name}" must be within [${String(min)}, ${String(max)}] inclusive, but was: ${String(value)}`,
    );
  }
}

export class GeoPoint {
  readonly #latitude: number;
  readonly #longitude: number;

  constructor(latitude: number, longitude: number) {
    validateCoordinate('latitude', latitude, -90, 90);
    validateCoordinate('longitude', longitude, -180, 180);
    this.#latitude = latitude;
    this.#longitude = longitude;
  }

  get latitude(): number {
    return this.#latitude;
  }

  get longitude(): number {
    return this.#longitude;
  }

  isEqual(other: GeoPoint): boolean {
    if (!(other instanceof GeoPoint)) {
      return false;
    }
    return this.#latitude === other.latitude && this.#longitude === other.longitude;
  }
}

export function isAdminGeoPoint(value: unknown): value is GeoPoint {
  return value instanceof GeoPoint;
}
