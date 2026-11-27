/// OpenAPI 3.0 / Gemini structured-output data types for [Schema].
enum SchemaType {
  string('string'),
  number('number'),
  integer('integer'),
  boolean('boolean'),
  array('array'),
  object('object');

  final String wireValue;

  const SchemaType(this.wireValue);

  /// Serializes this [SchemaType] to the lowercase Gemini wire string.
  String toJson() => wireValue;
}

/// Fluent OpenAPI 3.0 schema definition matching upstream `firebase_ai` [Schema].
///
/// Serializes via [toJson] to the exact Gemini REST / Pyric `AiBroker` wire JSON:
/// - [Schema.enumString] sets `type: 'string'`, `format: 'enum'`, and `enum`.
/// - [Schema.object] derives `required` from [properties] minus [optionalProperties],
///   validates every optional property key exists in [properties], omits
///   `optionalProperties` from wire JSON, and preserves [propertyOrdering].
/// - [Schema.anyOf] omits top-level `type` and serializes `anyOf` recursively.
class Schema {
  final SchemaType? type;
  final String? format;
  final String? description;
  final String? title;
  final bool? nullable;
  final List<String>? enumValues;
  final Schema? items;
  final int? minItems;
  final int? maxItems;
  final num? _rawMinimum;
  final num? _rawMaximum;
  final Map<String, Schema>? properties;
  final List<String>? optionalProperties;
  final List<String>? propertyOrdering;
  final List<Schema>? anyOf;
  final Map<String, dynamic>? _rawJsonOverride;

  double? get minimum => _rawMinimum?.toDouble();
  double? get maximum => _rawMaximum?.toDouble();

  /// Creates a [Schema] from a pre-serialized wire JSON map.
  Schema.fromJsonMap(Map<String, dynamic> json)
      : _rawJsonOverride = Map<String, dynamic>.unmodifiable(json),
        type = null,
        format = null,
        description = null,
        title = null,
        nullable = null,
        enumValues = null,
        items = null,
        minItems = null,
        maxItems = null,
        _rawMinimum = null,
        _rawMaximum = null,
        properties = null,
        optionalProperties = null,
        propertyOrdering = null,
        anyOf = null;

  /// Creates a [Schema] definition. Prefer the typed factory constructors
  /// ([Schema.string], [Schema.enumString], [Schema.integer], [Schema.number],
  /// [Schema.boolean], [Schema.array], [Schema.object], [Schema.anyOf]).
  Schema(
    this.type, {
    this.format,
    this.description,
    this.title,
    this.nullable,
    List<String>? enumValues,
    this.items,
    this.minItems,
    this.maxItems,
    num? minimum,
    num? maximum,
    Map<String, Schema>? properties,
    List<String>? optionalProperties,
    List<String>? propertyOrdering,
    List<Schema>? anyOf,
  })  : _rawJsonOverride = null,
        enumValues =
            enumValues != null ? List<String>.unmodifiable(enumValues) : null,
        _rawMinimum = minimum,
        _rawMaximum = maximum,
        properties = properties != null
            ? Map<String, Schema>.unmodifiable(properties)
            : null,
        optionalProperties = optionalProperties != null
            ? List<String>.unmodifiable(optionalProperties)
            : null,
        propertyOrdering = propertyOrdering != null
            ? List<String>.unmodifiable(propertyOrdering)
            : null,
        anyOf = anyOf != null ? List<Schema>.unmodifiable(anyOf) : null {
    if (_rawMinimum is double && !_rawMinimum.isFinite) {
      throw ArgumentError('Schema minimum must be finite, got $_rawMinimum.');
    }
    if (_rawMaximum is double && !_rawMaximum.isFinite) {
      throw ArgumentError('Schema maximum must be finite, got $_rawMaximum.');
    }
    final hasAnyOf = this.anyOf != null && this.anyOf!.isNotEmpty;
    if (type == null && !hasAnyOf) {
      throw ArgumentError(
        'A Schema must specify either a type or a non-empty anyOf list.',
      );
    }
    if (this.anyOf != null && this.anyOf!.isEmpty) {
      throw ArgumentError('The anyOf schema list must not be empty.');
    }
    if (this.optionalProperties != null && this.properties != null) {
      for (final key in this.optionalProperties!) {
        if (!this.properties!.containsKey(key)) {
          throw ArgumentError(
            'Property "$key" specified in optionalProperties does not exist in properties.',
          );
        }
      }
    }
  }

  /// Alias for [anyOf] matching callers that inspect `schema.schemas`.
  List<Schema>? get schemas => anyOf;

  /// Schema for a string value.
  factory Schema.string({
    String? description,
    bool? nullable,
    String? format,
    String? title,
    List<String>? enumValues,
  }) {
    String? resolvedFormat = format;
    if (resolvedFormat == null && enumValues != null) {
      resolvedFormat = 'enum';
    }
    return Schema(
      SchemaType.string,
      description: description,
      nullable: nullable,
      format: resolvedFormat,
      title: title,
      enumValues: enumValues,
    );
  }

  /// Schema for a string restricted to a fixed set of [enumValues].
  factory Schema.enumString({
    required List<String> enumValues,
    String? description,
    bool? nullable,
    String? title,
  }) {
    if (enumValues.isEmpty) {
      throw ArgumentError('Schema.enumString requires a non-empty enumValues list.');
    }
    return Schema(
      SchemaType.string,
      format: 'enum',
      enumValues: enumValues,
      description: description,
      nullable: nullable,
      title: title,
    );
  }

  /// Schema for a 64-bit integer value.
  factory Schema.integer({
    String? description,
    bool? nullable,
    String? format,
    int? minimum,
    int? maximum,
    String? title,
  }) {
    return Schema(
      SchemaType.integer,
      description: description,
      nullable: nullable,
      format: format,
      minimum: minimum,
      maximum: maximum,
      title: title,
    );
  }

  /// Schema for an IEEE-754 floating-point number value.
  factory Schema.number({
    String? description,
    bool? nullable,
    String? format,
    double? minimum,
    double? maximum,
    String? title,
  }) {
    return Schema(
      SchemaType.number,
      description: description,
      nullable: nullable,
      format: format,
      minimum: minimum,
      maximum: maximum,
      title: title,
    );
  }

  /// Schema for a boolean value.
  factory Schema.boolean({
    String? description,
    bool? nullable,
    String? title,
  }) {
    return Schema(
      SchemaType.boolean,
      description: description,
      nullable: nullable,
      title: title,
    );
  }

  /// Schema for a homogeneous JSON array whose elements conform to [items].
  factory Schema.array({
    required Schema items,
    String? description,
    bool? nullable,
    int? minItems,
    int? maxItems,
    String? title,
  }) {
    return Schema(
      SchemaType.array,
      items: items,
      description: description,
      nullable: nullable,
      minItems: minItems,
      maxItems: maxItems,
      title: title,
    );
  }

  /// Schema for a JSON object with named [properties].
  ///
  /// Every property key not listed in [optionalProperties] is serialized into
  /// the wire `required` array. [propertyOrdering] hints the preferred key
  /// emission order to Gemini structured generation.
  factory Schema.object({
    required Map<String, Schema> properties,
    List<String>? optionalProperties,
    List<String>? propertyOrdering,
    String? description,
    bool? nullable,
    String? title,
  }) {
    return Schema(
      SchemaType.object,
      properties: properties,
      optionalProperties: optionalProperties,
      propertyOrdering: propertyOrdering,
      description: description,
      nullable: nullable,
      title: title,
    );
  }

  /// Schema matching any one of the provided [schemas] (union / polymorphic value).
  factory Schema.anyOf({
    required List<Schema> schemas,
    String? description,
    bool? nullable,
    String? title,
  }) {
    return Schema(
      null,
      anyOf: schemas,
      description: description,
      nullable: nullable,
      title: title,
    );
  }

  /// Serializes this [Schema] recursively to Gemini REST wire JSON.
  Map<String, dynamic> toJson() {
    if (_rawJsonOverride != null) {
      return Map<String, dynamic>.from(_rawJsonOverride);
    }
    final json = <String, dynamic>{};
    if (type != null) {
      json['type'] = type!.toJson();
    }
    if (format != null) {
      json['format'] = format;
    }
    if (description != null) {
      json['description'] = description;
    }
    if (title != null) {
      json['title'] = title;
    }
    if (nullable != null) {
      json['nullable'] = nullable;
    }
    if (enumValues != null) {
      json['enum'] = List<String>.from(enumValues!);
    }
    if (items != null) {
      json['items'] = items!.toJson();
    }
    if (minItems != null) {
      json['minItems'] = minItems;
    }
    if (maxItems != null) {
      json['maxItems'] = maxItems;
    }
    if (_rawMinimum != null) {
      if (type == SchemaType.integer) {
        json['minimum'] = _rawMinimum is int ? _rawMinimum : _rawMinimum.toInt();
      } else {
        json['minimum'] = _rawMinimum.toDouble();
      }
    }
    if (_rawMaximum != null) {
      if (type == SchemaType.integer) {
        json['maximum'] = _rawMaximum is int ? _rawMaximum : _rawMaximum.toInt();
      } else {
        json['maximum'] = _rawMaximum.toDouble();
      }
    }
    if (properties != null) {
      final serializedProps = <String, dynamic>{};
      final optionalSet = optionalProperties?.toSet() ?? const <String>{};
      final requiredKeys = <String>[];
      for (final entry in properties!.entries) {
        serializedProps[entry.key] = entry.value.toJson();
        if (!optionalSet.contains(entry.key)) {
          requiredKeys.add(entry.key);
        }
      }
      json['properties'] = serializedProps;
      if (requiredKeys.isNotEmpty) {
        json['required'] = requiredKeys;
      }
    }
    if (propertyOrdering != null) {
      json['propertyOrdering'] = List<String>.from(propertyOrdering!);
    }
    if (anyOf != null) {
      json['anyOf'] = anyOf!.map((subSchema) => subSchema.toJson()).toList();
    }
    return json;
  }
}
