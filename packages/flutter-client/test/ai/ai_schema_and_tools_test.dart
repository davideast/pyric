import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/ai/ai_schema.dart';
import 'package:pyric_firestore/src/ai/ai_tool.dart';

void main() {
  group('Schema DSL wire serialization', () {
    test('serializes scalar string, integer, number, boolean, and enumString schemas', () {
      final strSchema = Schema.string(
        description: 'City name',
        nullable: true,
        title: 'City',
      );
      expect(
        strSchema.toJson(),
        equals(<String, dynamic>{
          'type': 'string',
          'description': 'City name',
          'title': 'City',
          'nullable': true,
        }),
      );

      final enumSchema = Schema.enumString(
        enumValues: <String>['celsius', 'fahrenheit'],
        description: 'Temperature unit',
      );
      expect(
        enumSchema.toJson(),
        equals(<String, dynamic>{
          'type': 'string',
          'format': 'enum',
          'description': 'Temperature unit',
          'enum': <String>['celsius', 'fahrenheit'],
        }),
      );

      final intSchema = Schema.integer(minimum: 0, maximum: 100, format: 'int32');
      expect(
        intSchema.toJson(),
        equals(<String, dynamic>{
          'type': 'integer',
          'format': 'int32',
          'minimum': 0,
          'maximum': 100,
        }),
      );

      final numSchema = Schema.number(minimum: 0.5, maximum: 99.5, format: 'double');
      expect(
        numSchema.toJson(),
        equals(<String, dynamic>{
          'type': 'number',
          'format': 'double',
          'minimum': 0.5,
          'maximum': 99.5,
        }),
      );

      final boolSchema = Schema.boolean(nullable: false);
      expect(
        boolSchema.toJson(),
        equals(<String, dynamic>{
          'type': 'boolean',
          'nullable': false,
        }),
      );
    });

    test('serializes nested array and object schemas with optionalProperties and propertyOrdering', () {
      final recipeSchema = Schema.object(
        description: 'Structured recipe response',
        properties: <String, Schema>{
          'title': Schema.string(description: 'Recipe title'),
          'servings': Schema.integer(minimum: 1),
          'notes': Schema.string(nullable: true),
          'tags': Schema.array(
            items: Schema.string(),
            minItems: 1,
            maxItems: 5,
          ),
        },
        optionalProperties: <String>['notes'],
        propertyOrdering: <String>['title', 'servings', 'tags', 'notes'],
      );

      final wire = recipeSchema.toJson();
      expect(wire['type'], equals('object'));
      expect(wire['description'], equals('Structured recipe response'));
      expect(wire.containsKey('optionalProperties'), isFalse);
      expect(wire['required'], equals(<String>['title', 'servings', 'tags']));
      expect(
        wire['propertyOrdering'],
        equals(<String>['title', 'servings', 'tags', 'notes']),
      );
      final props = wire['properties'] as Map<String, dynamic>;
      expect(props['tags'], equals(<String, dynamic>{
        'type': 'array',
        'items': <String, dynamic>{'type': 'string'},
        'minItems': 1,
        'maxItems': 5,
      }));
    });

    test('serializes anyOf union schema without top-level type and validates invariants', () {
      final unionSchema = Schema.anyOf(
        description: 'Identifier as string or integer',
        schemas: <Schema>[
          Schema.string(description: 'Slug id'),
          Schema.integer(description: 'Numeric id'),
        ],
      );

      expect(unionSchema.type, isNull);
      expect(unionSchema.schemas, hasLength(2));
      expect(
        unionSchema.toJson(),
        equals(<String, dynamic>{
          'description': 'Identifier as string or integer',
          'anyOf': <Map<String, dynamic>>[
            <String, dynamic>{'type': 'string', 'description': 'Slug id'},
            <String, dynamic>{'type': 'integer', 'description': 'Numeric id'},
          ],
        }),
      );

      expect(
        () => Schema.anyOf(schemas: <Schema>[]),
        throwsArgumentError,
      );
      expect(
        () => Schema.enumString(enumValues: <String>[]),
        throwsArgumentError,
      );
      expect(
        () => Schema.object(
          properties: <String, Schema>{'a': Schema.string()},
          optionalProperties: <String>['non_existent'],
        ),
        throwsArgumentError,
      );
    });
  });

  group('Tool, FunctionDeclaration, and ToolConfig wire serialization', () {
    test('serializes FunctionDeclaration required and optionalParameters cleanly', () {
      final getWeather = FunctionDeclaration(
        'get_current_weather',
        'Fetch current weather for a city',
        parameters: <String, Schema>{
          'location': Schema.string(description: 'City and state'),
          'unit': Schema.enumString(enumValues: <String>['celsius', 'fahrenheit']),
        },
        optionalParameters: <String>['unit'],
      );
      final getClock = FunctionDeclaration(
        'get_clock',
        'Returns server timestamp',
      );

      final tool = Tool.functionDeclarations(<FunctionDeclaration>[
        getWeather,
        getClock,
      ]);
      final wire = tool.toJson();
      final decls = wire['functionDeclarations'] as List<dynamic>;
      expect(decls, hasLength(2));

      final weatherWire = decls[0] as Map<String, dynamic>;
      expect(weatherWire['name'], equals('get_current_weather'));
      expect(weatherWire['description'], equals('Fetch current weather for a city'));
      final paramsWire = weatherWire['parameters'] as Map<String, dynamic>;
      expect(paramsWire['type'], equals('object'));
      expect(paramsWire['required'], equals(<String>['location']));
      expect(
        (paramsWire['properties'] as Map<String, dynamic>).keys,
        containsAll(<String>['location', 'unit']),
      );

      final clockWire = decls[1] as Map<String, dynamic>;
      expect(clockWire, equals(<String, dynamic>{
        'name': 'get_clock',
        'description': 'Returns server timestamp',
      }));
    });

    test('serializes ToolConfig and FunctionCallingConfig modes auto, any, and none', () {
      final autoCfg = ToolConfig(
        functionCallingConfig: FunctionCallingConfig.auto(),
      );
      expect(
        autoCfg.toJson(),
        equals(<String, dynamic>{
          'functionCallingConfig': <String, dynamic>{'mode': 'AUTO'},
        }),
      );

      final anyRestrictedCfg = ToolConfig(
        functionCallingConfig: FunctionCallingConfig.any(<String>[
          'get_current_weather',
        ]),
      );
      expect(
        anyRestrictedCfg.toJson(),
        equals(<String, dynamic>{
          'functionCallingConfig': <String, dynamic>{
            'mode': 'ANY',
            'allowedFunctionNames': <String>['get_current_weather'],
          },
        }),
      );

      final anyUnrestrictedCfg = ToolConfig(
        functionCallingConfig: FunctionCallingConfig.any(),
      );
      expect(
        anyUnrestrictedCfg.toJson(),
        equals(<String, dynamic>{
          'functionCallingConfig': <String, dynamic>{'mode': 'ANY'},
        }),
      );

      final noneCfg = ToolConfig(
        functionCallingConfig: FunctionCallingConfig.none(),
      );
      expect(
        noneCfg.toJson(),
        equals(<String, dynamic>{
          'functionCallingConfig': <String, dynamic>{'mode': 'NONE'},
        }),
      );
    });
  });
}
