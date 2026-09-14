import { boundedActivityIdentity, registerActivityValue } from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';

export class GeoPoint {
  constructor(
    private readonly lat: number,
    private readonly lng: number,
  ) {
    const isInvalidLatitude = !Number.isFinite(lat) || lat < -90 || lat > 90;
    if (isInvalidLatitude) {
      throw new TypeError('Latitude must be a number between -90 and 90.');
    }
    const isInvalidLongitude = !Number.isFinite(lng) || lng < -180 || lng > 180;
    if (isInvalidLongitude) {
      throw new TypeError('Longitude must be a number between -180 and 180.');
    }
    registerActivityValue(
      this,
      boundedActivityIdentity('geo-point', String(lat), '\0', String(lng)),
    );
    registerQueryValue(this, Object.freeze({
      type: 'geo-point',
      latitude: lat,
      longitude: lng,
    }), () => new GeoPoint(lat, lng));
  }

  get latitude(): number { return this.lat; }
  get longitude(): number { return this.lng; }

  isEqual(other: GeoPoint): boolean {
    return other instanceof GeoPoint
      && this.lat === other.lat
      && this.lng === other.lng;
  }

  toJSON(): { latitude: number; longitude: number; type: string } {
    return {
      latitude: this.lat,
      longitude: this.lng,
      type: 'firestore/geoPoint/1.0',
    };
  }

  static fromJSON(json: object): GeoPoint {
    const value = json as { readonly type?: unknown; readonly latitude?: unknown; readonly longitude?: unknown };
    const hasUnexpectedMarker = value.type !== 'firestore/geoPoint/1.0';
    const isInvalidGeoPointJson = hasUnexpectedMarker
      || typeof value.latitude !== 'number'
      || typeof value.longitude !== 'number';
    if (isInvalidGeoPointJson) {
      throw new TypeError('Invalid GeoPoint JSON value.');
    }
    return new GeoPoint(value.latitude, value.longitude);
  }
}
