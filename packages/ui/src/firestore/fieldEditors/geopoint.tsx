import { useFormControl } from '../../primitives/FormControl.js';
import { GeoPoint } from 'pyric/firestore';
import type { FieldEditorContract, FieldDisplayProps, FieldEditProps } from './types.js';

function GeoPointDisplay({ value, path }: FieldDisplayProps<GeoPoint>) {
  return (
    <span
      data-pyric-field-type="geopoint"
      data-pyric-field-path={path}
      data-lat={String(value.latitude)}
      data-lng={String(value.longitude)}
    >
      {value.latitude}, {value.longitude}
    </span>
  );
}

function GeoPointEdit({ value, onChange, error, path }: FieldEditProps<GeoPoint>) {
  const formControl = useFormControl({ error });
  return (
    <span
      data-pyric-field-type="geopoint"
      data-pyric-field-path={path}
      data-pyric-error={error ? '' : undefined}
    >
      <label>
        <input
          type="number"
          step="any"
          min={-90}
          max={90}
          value={value.latitude}
          onChange={(e) => {
            const lat = parseFloat(e.target.value);
            try {
              onChange(new GeoPoint(lat, value.longitude));
            } catch {
              // GeoPoint constructor throws on out-of-range. Leave
              // the previous value in place; the validator will
              // surface the issue on next render.
            }
          }}
          aria-label="Latitude"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={formControl.describedBy}
        />
      </label>
      <label>
        <input
          type="number"
          step="any"
          min={-180}
          max={180}
          value={value.longitude}
          onChange={(e) => {
            const lng = parseFloat(e.target.value);
            try {
              onChange(new GeoPoint(value.latitude, lng));
            } catch {
              // see above
            }
          }}
          aria-label="Longitude"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={formControl.describedBy}
        />
      </label>
      {error ? (
        <span id={formControl.errorId} data-pyric-error-message>
          {error}
        </span>
      ) : null}
    </span>
  );
}

export const geopointEditor: FieldEditorContract<GeoPoint> = {
  type: 'geopoint',
  Display: GeoPointDisplay,
  Edit: GeoPointEdit,
};
