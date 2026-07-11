/**
 * `Schema` builder classes for `pyric/ai` — a faithful port of the installed
 * `@firebase/ai@2.12.0` schema-builder (dist/index.node.mjs), including the
 * `toJSON()` serialization the SDK relies on when the request body is
 * JSON.stringify'd: `required` derived from `optionalProperties`, nested
 * schemas serialized recursively, `anyOf` with no top-level type.
 *
 * ONE deliberate delta from the installed 2.12.0, pinned by the registry row
 * ai#schema-string-enum: `Schema.enumString` sets `format: 'enum'` (GoogleAI
 * accepts only `enum` and `date-time` formats; the installed builder omits
 * it and produces requests GoogleAI rejects).
 */

import { AIError, AIErrorCode } from './errors.js';
import { SchemaType } from './enums.js';

/** Params accepted by the static builders (upstream `SchemaParams` shape). */
export interface SchemaParams {
  type?: SchemaType;
  format?: string;
  description?: string;
  title?: string;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  optionalProperties?: string[];
  propertyOrdering?: string[];
  enum?: string[];
  example?: unknown;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  anyOf?: TypedSchema[];
  [key: string]: unknown;
}

/** Union of all concrete schema classes. */
export type TypedSchema =
  | IntegerSchema
  | NumberSchema
  | StringSchema
  | BooleanSchema
  | ObjectSchema
  | ArraySchema
  | AnyOfSchema;

/**
 * Parent class encompassing all Schema types. Converts with
 * `JSON.stringify()` into the JSON string the REST endpoints accept.
 */
export abstract class Schema {
  type?: SchemaType;
  format?: string;
  nullable: boolean;
  [key: string]: unknown;

  constructor(schemaParams: SchemaParams) {
    if (!schemaParams.type && !schemaParams.anyOf) {
      throw new AIError(
        AIErrorCode.INVALID_SCHEMA,
        "A schema must have either a 'type' or an 'anyOf' array of sub-schemas.",
      );
    }
    for (const paramKey in schemaParams) {
      this[paramKey] = schemaParams[paramKey];
    }
    this.type = schemaParams.type;
    this.format = Object.prototype.hasOwnProperty.call(schemaParams, 'format')
      ? schemaParams.format
      : undefined;
    this.nullable = Object.prototype.hasOwnProperty.call(schemaParams, 'nullable')
      ? !!schemaParams.nullable
      : false;
  }

  /** Serialization the request body applies via `JSON.stringify`. */
  toJSON(): Record<string, unknown> {
    const obj: Record<string, unknown> = { type: this.type };
    for (const prop in this) {
      if (Object.prototype.hasOwnProperty.call(this, prop) && this[prop] !== undefined) {
        if (prop !== 'required' || this.type === SchemaType.OBJECT) {
          obj[prop] = this[prop];
        }
      }
    }
    return obj;
  }

  static array(arrayParams: SchemaParams & { items: TypedSchema }): ArraySchema {
    return new ArraySchema(arrayParams, arrayParams.items);
  }

  static object(
    objectParams: SchemaParams & {
      properties: Record<string, TypedSchema>;
      optionalProperties?: string[];
    },
  ): ObjectSchema {
    return new ObjectSchema(objectParams, objectParams.properties, objectParams.optionalProperties);
  }

  static string(stringParams?: SchemaParams): StringSchema {
    return new StringSchema(stringParams);
  }

  static enumString(stringParams: SchemaParams & { enum: string[] }): StringSchema {
    // Pinned delta vs installed 2.12.0: GoogleAI requires format 'enum'.
    return new StringSchema({ format: 'enum', ...stringParams }, stringParams.enum);
  }

  static integer(integerParams?: SchemaParams): IntegerSchema {
    return new IntegerSchema(integerParams);
  }

  static number(numberParams?: SchemaParams): NumberSchema {
    return new NumberSchema(numberParams);
  }

  static boolean(booleanParams?: SchemaParams): BooleanSchema {
    return new BooleanSchema(booleanParams);
  }

  static anyOf(anyOfParams: SchemaParams & { anyOf: TypedSchema[] }): AnyOfSchema {
    return new AnyOfSchema(anyOfParams);
  }
}

/** Schema class for "integer" types. */
export class IntegerSchema extends Schema {
  constructor(schemaParams?: SchemaParams) {
    super({ type: SchemaType.INTEGER, ...schemaParams });
  }
}

/** Schema class for "number" types. */
export class NumberSchema extends Schema {
  constructor(schemaParams?: SchemaParams) {
    super({ type: SchemaType.NUMBER, ...schemaParams });
  }
}

/** Schema class for "boolean" types. */
export class BooleanSchema extends Schema {
  constructor(schemaParams?: SchemaParams) {
    super({ type: SchemaType.BOOLEAN, ...schemaParams });
  }
}

/** Schema class for "string" types, with or without enum values. */
export class StringSchema extends Schema {
  enum?: string[];

  constructor(schemaParams?: SchemaParams, enumValues?: string[]) {
    super({ type: SchemaType.STRING, ...schemaParams });
    this.enum = enumValues;
  }

  override toJSON(): Record<string, unknown> {
    const obj = super.toJSON();
    if (this.enum) {
      obj['enum'] = this.enum;
    }
    return obj;
  }
}

/** Schema class for "array" types; `items` is the member schema. */
export class ArraySchema extends Schema {
  items: TypedSchema;

  constructor(schemaParams: SchemaParams, items: TypedSchema) {
    super({ type: SchemaType.ARRAY, ...schemaParams });
    this.items = items;
  }

  override toJSON(): Record<string, unknown> {
    const obj = super.toJSON();
    obj.items = this.items.toJSON();
    return obj;
  }
}

/** Schema class for "object" types; `properties` maps names to Schemas. */
export class ObjectSchema extends Schema {
  properties: Record<string, TypedSchema>;
  optionalProperties: string[];

  constructor(
    schemaParams: SchemaParams,
    properties: Record<string, TypedSchema>,
    optionalProperties: string[] = [],
  ) {
    super({ type: SchemaType.OBJECT, ...schemaParams });
    this.properties = properties;
    this.optionalProperties = optionalProperties;
  }

  override toJSON(): Record<string, unknown> {
    const obj = super.toJSON();
    const serialized: Record<string, unknown> = { ...this.properties };
    const required: string[] = [];
    for (const propertyKey of this.optionalProperties) {
      if (!Object.prototype.hasOwnProperty.call(this.properties, propertyKey)) {
        throw new AIError(
          AIErrorCode.INVALID_SCHEMA,
          `Property "${propertyKey}" specified in "optionalProperties" does not exist.`,
        );
      }
    }
    for (const propertyKey in this.properties) {
      if (Object.prototype.hasOwnProperty.call(this.properties, propertyKey)) {
        serialized[propertyKey] = this.properties[propertyKey]!.toJSON();
        if (!this.optionalProperties.includes(propertyKey)) {
          required.push(propertyKey);
        }
      }
    }
    obj.properties = serialized;
    if (required.length > 0) {
      obj.required = required;
    }
    delete obj.optionalProperties;
    return obj;
  }
}

/** Schema for a value conforming to ANY of the provided sub-schemas. */
export class AnyOfSchema extends Schema {
  anyOf: TypedSchema[];

  constructor(schemaParams: SchemaParams & { anyOf: TypedSchema[] }) {
    if (schemaParams.anyOf.length === 0) {
      throw new AIError(AIErrorCode.INVALID_SCHEMA, "The 'anyOf' array must not be empty.");
    }
    super({ ...schemaParams, type: undefined });
    this.anyOf = schemaParams.anyOf;
  }

  override toJSON(): Record<string, unknown> {
    const obj = super.toJSON();
    if (this.anyOf && Array.isArray(this.anyOf)) {
      obj.anyOf = this.anyOf.map((s) => s.toJSON());
    }
    return obj;
  }
}
