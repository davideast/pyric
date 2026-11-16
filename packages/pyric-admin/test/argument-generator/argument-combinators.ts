/**
 * Service-agnostic schema and grammar combinators for generating Admin SDK
 * argument edge cases (Messaging first; reusable for Auth, Storage, Firestore).
 *
 * Every candidate carries a `build()` thunk so mutable arrays, plain objects,
 * and null-prototype objects are freshly allocated per SDK invocation (never
 * sharing references across upstream vs local vs remote runs).
 */

export interface CandidateValue {
  readonly label: string;
  readonly value: unknown;
  readonly build: () => unknown;
}

export interface ClauseShape {
  readonly label: string;
  readonly render: (clauseIndex: number, keywordSeparator: string) => string;
}

export interface BoundedCollectionOptions {
  readonly createValidElement: (index: number) => unknown;
  readonly maxLength: number;
  readonly extraElementCandidates?: () => readonly CandidateValue[];
}

export interface PrefixedIdentifierOptions {
  readonly prefixes: readonly string[];
  readonly bodies: readonly string[];
}

export interface BooleanExpressionOptions {
  readonly clauseCounts: readonly number[];
  readonly operators: readonly string[];
  readonly keywordSeparators: readonly string[];
  readonly clauseShapes: readonly ClauseShape[];
}

export interface StringMapOptions {
  readonly sampleKey: string;
  readonly validValue: string;
  readonly maxByteLength?: number;
}

export type FieldSchema =
  | ScalarFieldSchema
  | BoundedArrayFieldSchema
  | PrefixedIdentifierFieldSchema
  | BooleanClauseExpressionFieldSchema
  | StringMapFieldSchema
  | ObjectFieldSchema;

export interface ScalarFieldSchema {
  readonly tag: 'scalar';
  readonly mutuallyExclusiveWith: readonly string[];
  readonly extraCandidates?: () => readonly CandidateValue[];
}

export interface BoundedArrayFieldSchema {
  readonly tag: 'bounded-array';
  readonly createValidElement: (index: number) => unknown;
  readonly maxLength: number;
  readonly allowSingleScalarElement: boolean;
  readonly itemSchema?: FieldSchema;
}

export interface PrefixedIdentifierFieldSchema extends PrefixedIdentifierOptions {
  readonly tag: 'prefixed-identifier';
  readonly mutuallyExclusiveWith: readonly string[];
}

export interface BooleanClauseExpressionFieldSchema extends BooleanExpressionOptions {
  readonly tag: 'boolean-expression';
  readonly mutuallyExclusiveWith: readonly string[];
}

export interface StringMapFieldSchema extends StringMapOptions {
  readonly tag: 'string-map';
}

export interface ObjectFieldSchema {
  readonly tag: 'object';
  readonly validBase: () => Record<string, unknown>;
  readonly fields: Readonly<Record<string, FieldSchema>>;
  readonly mutuallyExclusiveWith: readonly string[];
}

export interface ParameterDescriptor {
  readonly name: string;
  readonly validValue: () => unknown;
  readonly schema: FieldSchema;
  readonly omitTrailingUndefined?: boolean;
}

export interface MethodSchema {
  readonly name: string;
  readonly parameters: readonly ParameterDescriptor[];
}

export interface GeneratedArgumentCase {
  readonly methodName: string;
  readonly label: string;
  readonly parameterName: string;
  readonly args: unknown[];
  readonly buildArgs: () => unknown[];
}

export function makeCandidate(label: string, build: () => unknown): CandidateValue {
  return {
    label,
    get value(): unknown {
      return build();
    },
    build,
  };
}

/**
 * Combinator 1 -- Type-wrongness: emits the 14 canonical boundary types for any
 * parameter or nested field position.
 */
export function emitTypeWrongnessCandidates(): CandidateValue[] {
  return [
    makeCandidate('undefined', () => undefined),
    makeCandidate('null', () => null),
    makeCandidate('false', () => false),
    makeCandidate('true', () => true),
    makeCandidate('0', () => 0),
    makeCandidate('1', () => 1),
    makeCandidate('NaN', () => Number.NaN),
    makeCandidate('""', () => ''),
    makeCandidate('"true"', () => 'true'),
    makeCandidate('[]', () => []),
    makeCandidate('[""]', () => ['']),
    makeCandidate('[123]', () => [123]),
    makeCandidate('{}', () => ({})),
    makeCandidate('Object.create(null)', () => Object.create(null) as unknown),
  ];
}

/**
 * Combinator 2 -- Collection cardinality: emits `[0, 1, MAX, MAX + 1]` lengths,
 * single-element and second-element wrong-type injections, and wrong containers.
 */
export function emitBoundedCollectionCandidates(options: BoundedCollectionOptions): CandidateValue[] {
  const { createValidElement, maxLength, extraElementCandidates } = options;
  const lengths = [0, 1, maxLength, maxLength + 1];
  const results: CandidateValue[] = [];

  for (const length of lengths) {
    results.push(
      makeCandidate(`length=${length}`, () =>
        Array.from({ length }, (_, index) => createValidElement(index)),
      ),
    );
  }

  for (const wrong of emitTypeWrongnessCandidates()) {
    results.push(makeCandidate(`element[0]=${wrong.label}`, () => [wrong.build()]));
    results.push(
      makeCandidate(`element[1]=${wrong.label}`, () => [createValidElement(0), wrong.build()]),
    );
    if (!Array.isArray(wrong.value)) {
      results.push(makeCandidate(`container=${wrong.label}`, () => wrong.build()));
    }
  }

  if (extraElementCandidates !== undefined) {
    for (const item of extraElementCandidates()) {
      results.push(makeCandidate(`item=${item.label}`, () => [item.build()]));
    }
  }

  return results;
}

/**
 * Combinator 3a -- Prefixed-identifier grammar: cartesian product of prefix
 * forms and body atoms.
 */
export function emitPrefixedIdentifierCandidates(
  options: PrefixedIdentifierOptions,
): CandidateValue[] {
  const results: CandidateValue[] = [];
  for (const prefix of options.prefixes) {
    for (const body of options.bodies) {
      const combined = `${prefix}${body}`;
      const label = `${JSON.stringify(prefix)}+${JSON.stringify(body)}`;
      results.push(makeCandidate(label, () => combined));
    }
  }
  return results;
}

function separatorLabel(separator: string): string {
  if (separator === ' ') return 'space';
  if (separator === '\t') return 'tab';
  if (separator === '') return 'none';
  return JSON.stringify(separator);
}

/**
 * Combinator 3b -- Boolean clause expression grammar: cartesian product of
 * clause counts, binary operators, keyword whitespace, and quote/identifier
 * clause shapes, plus trailing-operator truncation.
 */
export function emitBooleanExpressionCandidates(
  options: BooleanExpressionOptions,
): CandidateValue[] {
  const results: CandidateValue[] = [];
  for (const count of options.clauseCounts) {
    for (const operator of options.operators) {
      for (const separator of options.keywordSeparators) {
        for (const shape of options.clauseShapes) {
          const clauses: string[] = [];
          for (let index = 0; index < count; index++) {
            clauses.push(shape.render(index, separator));
          }
          const expression = clauses.join(` ${operator} `);
          const wsTag = separatorLabel(separator);
          const label = `clauses=${count},op=${operator},ws=${wsTag},shape=${shape.label}`;
          results.push(makeCandidate(label, () => expression));
        }
      }
    }
  }

  for (const operator of options.operators) {
    const firstShape = options.clauseShapes[0];
    if (firstShape !== undefined) {
      const dangling = `${firstShape.render(0, ' ')} ${operator}`;
      results.push(makeCandidate(`dangling-op=${operator}`, () => dangling));
    }
  }

  return results;
}

function isPlainMapContainer(sample: unknown): boolean {
  return typeof sample === 'object' && sample !== null && !Array.isArray(sample);
}

/**
 * Combinator 3c -- String map grammar: valid string entries, empty plain and
 * null-prototype maps, maps carrying every type-wrongness candidate as a value,
 * non-plain-object containers, and optional byte-cap boundary values.
 */
export function emitStringMapCandidates(options: StringMapOptions): CandidateValue[] {
  const { sampleKey, validValue, maxByteLength } = options;
  const results: CandidateValue[] = [
    makeCandidate('valid-map', () => ({ [sampleKey]: validValue })),
    makeCandidate('empty-plain-map', () => ({})),
    makeCandidate('empty-null-proto-map', () => Object.create(null) as unknown),
  ];

  for (const wrong of emitTypeWrongnessCandidates()) {
    results.push(
      makeCandidate(`value=${wrong.label}`, () => ({
        [sampleKey]: wrong.build(),
      })),
    );
    if (!isPlainMapContainer(wrong.value)) {
      results.push(makeCandidate(`container=${wrong.label}`, () => wrong.build()));
    }
  }

  if (maxByteLength !== undefined) {
    const keyBytes = new TextEncoder().encode(sampleKey).length;
    const atCapLength = Math.max(0, maxByteLength - keyBytes);
    const overCapLength = atCapLength + 1;
    results.push(
      makeCandidate(`bytes=${maxByteLength}`, () => ({
        [sampleKey]: 'x'.repeat(atCapLength),
      })),
    );
    results.push(
      makeCandidate(`bytes=${maxByteLength + 1}`, () => ({
        [sampleKey]: 'x'.repeat(overCapLength),
      })),
    );
  }

  return results;
}

export function scalarSchema(
  options: {
    mutuallyExclusiveWith?: readonly string[];
    extraCandidates?: () => readonly CandidateValue[];
  } = {},
): ScalarFieldSchema {
  return {
    tag: 'scalar',
    mutuallyExclusiveWith: options.mutuallyExclusiveWith ?? [],
    extraCandidates: options.extraCandidates,
  };
}

export function boundedArraySchema(options: {
  createValidElement: (index: number) => unknown;
  maxLength: number;
  allowSingleScalarElement?: boolean;
  itemSchema?: FieldSchema;
}): BoundedArrayFieldSchema {
  return {
    tag: 'bounded-array',
    createValidElement: options.createValidElement,
    maxLength: options.maxLength,
    allowSingleScalarElement: options.allowSingleScalarElement === true,
    itemSchema: options.itemSchema,
  };
}

export function prefixedIdentifierSchema(
  options: PrefixedIdentifierOptions & {
    mutuallyExclusiveWith?: readonly string[];
  },
): PrefixedIdentifierFieldSchema {
  return {
    tag: 'prefixed-identifier',
    prefixes: options.prefixes,
    bodies: options.bodies,
    mutuallyExclusiveWith: options.mutuallyExclusiveWith ?? [],
  };
}

export function booleanClauseExpressionSchema(
  options: BooleanExpressionOptions & {
    mutuallyExclusiveWith?: readonly string[];
  },
): BooleanClauseExpressionFieldSchema {
  return {
    tag: 'boolean-expression',
    clauseCounts: options.clauseCounts,
    operators: options.operators,
    keywordSeparators: options.keywordSeparators,
    clauseShapes: options.clauseShapes,
    mutuallyExclusiveWith: options.mutuallyExclusiveWith ?? [],
  };
}

export function stringMapSchema(options: StringMapOptions): StringMapFieldSchema {
  return {
    tag: 'string-map',
    sampleKey: options.sampleKey,
    validValue: options.validValue,
    maxByteLength: options.maxByteLength,
  };
}

export function objectSchema(options: {
  validBase: () => Record<string, unknown>;
  fields: Readonly<Record<string, FieldSchema>>;
  mutuallyExclusiveWith?: readonly string[];
}): ObjectFieldSchema {
  return {
    tag: 'object',
    validBase: options.validBase,
    fields: options.fields,
    mutuallyExclusiveWith: options.mutuallyExclusiveWith ?? [],
  };
}

export function methodSchema(options: MethodSchema): MethodSchema {
  return options;
}

function mutuallyExclusivePeers(schema: FieldSchema): readonly string[] {
  if (
    schema.tag === 'scalar' ||
    schema.tag === 'prefixed-identifier' ||
    schema.tag === 'boolean-expression' ||
    schema.tag === 'object'
  ) {
    return schema.mutuallyExclusiveWith;
  }
  return [];
}

export function emitFieldCandidates(schema: FieldSchema, pathPrefix: string): CandidateValue[] {
  if (schema.tag === 'scalar') {
    const candidates = emitTypeWrongnessCandidates().map((entry) =>
      makeCandidate(`${pathPrefix}=${entry.label}`, entry.build),
    );
    if (schema.extraCandidates !== undefined) {
      for (const extra of schema.extraCandidates()) {
        candidates.push(makeCandidate(`${pathPrefix}=${extra.label}`, extra.build));
      }
    }
    return candidates;
  }

  if (schema.tag === 'prefixed-identifier') {
    const typeWrong = emitTypeWrongnessCandidates().map((entry) =>
      makeCandidate(`${pathPrefix}=type:${entry.label}`, entry.build),
    );
    const grammar = emitPrefixedIdentifierCandidates(schema).map((entry) =>
      makeCandidate(`${pathPrefix}=id:${entry.label}`, entry.build),
    );
    return [...typeWrong, ...grammar];
  }

  if (schema.tag === 'boolean-expression') {
    const typeWrong = emitTypeWrongnessCandidates().map((entry) =>
      makeCandidate(`${pathPrefix}=type:${entry.label}`, entry.build),
    );
    const grammar = emitBooleanExpressionCandidates(schema).map((entry) =>
      makeCandidate(`${pathPrefix}=expr:${entry.label}`, entry.build),
    );
    return [...typeWrong, ...grammar];
  }

  if (schema.tag === 'string-map') {
    return emitStringMapCandidates(schema).map((entry) =>
      makeCandidate(`${pathPrefix}=${entry.label}`, entry.build),
    );
  }

  if (schema.tag === 'bounded-array') {
    const itemSchema = schema.itemSchema;
    let extraElementCandidates: (() => readonly CandidateValue[]) | undefined;
    if (itemSchema !== undefined) {
      extraElementCandidates = () => emitFieldCandidates(itemSchema, 'item');
    }
    const collectionCandidates = emitBoundedCollectionCandidates({
      createValidElement: schema.createValidElement,
      maxLength: schema.maxLength,
      extraElementCandidates,
    }).map((entry) => makeCandidate(`${pathPrefix}[${entry.label}]`, entry.build));
    if (schema.allowSingleScalarElement) {
      collectionCandidates.push(
        makeCandidate(`${pathPrefix}=single-valid`, () => schema.createValidElement(0)),
      );
    }
    return collectionCandidates;
  }

  // schema.tag === 'object'
  const containerWrong = emitTypeWrongnessCandidates().map((entry) =>
    makeCandidate(`${pathPrefix}=container:${entry.label}`, entry.build),
  );
  const nestedCandidates: CandidateValue[] = [];
  for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
    const childPrefix = `${pathPrefix}.${fieldName}`;
    const childCandidates = emitFieldCandidates(fieldSchema, childPrefix);
    const excludedKeys = mutuallyExclusivePeers(fieldSchema);
    for (const child of childCandidates) {
      nestedCandidates.push(
        makeCandidate(child.label, () => {
          const base = { ...schema.validBase() };
          for (const key of excludedKeys) {
            delete base[key];
          }
          base[fieldName] = child.build();
          return base;
        }),
      );
    }
  }
  return [...containerWrong, ...nestedCandidates];
}

function shouldOmitTrailingUndefined(
  param: ParameterDescriptor,
  paramIndex: number,
  parameterCount: number,
  builtArgs: readonly unknown[],
): boolean {
  return (
    param.omitTrailingUndefined === true &&
    paramIndex === parameterCount - 1 &&
    builtArgs[paramIndex] === undefined
  );
}

/**
 * Expands a declarative `MethodSchema` into single-parameter / nested-field
 * candidate invocations while holding sibling parameters at valid baselines.
 */
export function generateMethodArgumentCases(schema: MethodSchema): GeneratedArgumentCase[] {
  if (schema.parameters.length === 0) {
    const strayWrong = emitTypeWrongnessCandidates().map((entry) => ({
      methodName: schema.name,
      label: `extraArg=${entry.label}`,
      parameterName: 'extraArg',
      get args(): unknown[] {
        return [entry.build()];
      },
      buildArgs: () => [entry.build()],
    }));
    return [
      {
        methodName: schema.name,
        label: 'no-args',
        parameterName: 'none',
        args: [],
        buildArgs: () => [],
      },
      ...strayWrong,
    ];
  }

  const cases: GeneratedArgumentCase[] = [];
  schema.parameters.forEach((param, paramIndex) => {
    const fieldCandidates = emitFieldCandidates(param.schema, param.name);
    for (const candidate of fieldCandidates) {
      const buildArgs = (): unknown[] => {
        const built = schema.parameters.map((entry, idx) => {
          if (idx === paramIndex) {
            return candidate.build();
          }
          return entry.validValue();
        });
        if (shouldOmitTrailingUndefined(param, paramIndex, schema.parameters.length, built)) {
          built.pop();
        }
        return built;
      };
      cases.push({
        methodName: schema.name,
        label: candidate.label,
        parameterName: param.name,
        get args(): unknown[] {
          return buildArgs();
        },
        buildArgs,
      });
    }
  });
  return cases;
}
