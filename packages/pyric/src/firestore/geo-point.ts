import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { validateFirestoreJson, type JsonObjectSchema } from './json-schema.js';
import { boundedActivityIdentity, registerActivityValue } from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';

const GEOPOINT_JSON_TYPE = 'firestore/geoPoint/1.0';
const GEOPOINT_JSON_SCHEMA: JsonObjectSchema = {
  type: { typeString: 'string', expectedValue: GEOPOINT_JSON_TYPE },
  latitude: { typeString: 'number' },
  longitude: { typeString: 'number' },
};

export class GeoPoint {
  constructor(
    private readonly lat: number,
    private readonly lng: number,
  ) {
    const isInvalidLatitude = typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90;
    if (isInvalidLatitude) {
      throw new FirebaseError(
        'invalid-argument',
        `Latitude must be a number between -90 and 90, but was: ${String(lat)}`,
      );
    }
    const isInvalidLongitude = typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180;
    if (isInvalidLongitude) {
      throw new FirebaseError(
        'invalid-argument',
        `Longitude must be a number between -180 and 180, but was: ${String(lng)}`,
      );
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
      type: GEOPOINT_JSON_TYPE,
    };
  }

  static fromJSON(json: object): GeoPoint {
    const validated = validateFirestoreJson(json, GEOPOINT_JSON_SCHEMA);
    return new GeoPoint(validated.latitude as number, validated.longitude as number);
  }
}
