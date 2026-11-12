import { describeRulesType } from './rules-type.js';
import { RulesValue } from './wrappers/base.js';
import { formatRulesFloat, RulesFloat } from './wrappers/float.js';
import { Reference } from './wrappers/reference.js';
import { inInt64, rulesFloatValue, rulesInt, rulesNumberAsDouble, truncateToInt } from './rules-int.js';

/**
 * The global conversion functions of the rules language: `int()`, `float()`,
 * and `string()`. Firestore and Storage rules share them, and both
 * evaluators call `applyConversion`. Corpus scenarios `conversion-functions`
 * (Storage) and `time-math-and-casts` (Firestore) record the production
 * verdicts.
 *
 * A failure is returned as a `ConversionFailure` carrying production's
 * message. Each evaluator turns it into its own error value, so `&&` and `||`
 * can absorb it. Production has no global `bool()` in either service, so a
 * `bool` call is a function-not-found error (Storage corpus scenario
 * `bool-function`).
 */
export class ConversionFailure {
  constructor(readonly message: string) {}
}

interface Conversion {
  /** The overload list production prints in its argument errors. */
  readonly overloads: string;
  convert(value: unknown): unknown;
}


// A whole decimal string with an optional sign: no whitespace, fraction,
// exponent, or radix prefix.
const INT_TEXT = /^[+-]?\d+$/;
// Decimal float text with an optional exponent and an f or d suffix, plus
// the NaN and Infinity spellings.
const DECIMAL_FLOAT_TEXT = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;
// Hexadecimal float text: mantissa digits, a binary exponent, and an optional
// f or d suffix.
const HEX_FLOAT_TEXT = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)[fFdD]?$/;

function conversionError(text: string, to: 'int' | 'float'): ConversionFailure {
  return new ConversionFailure(
    `Type conversion error. Argument: [${text}], From type: [string], To type: [${to}].`,
  );
}

function unsupported(name: string, value: unknown, overloads: string): ConversionFailure {
  return new ConversionFailure(
    `Unsupported operation error. Received: ${name}(${describeRulesType(value)}). Expected: ${overloads}.`,
  );
}

function parseInt64(text: string): bigint | ConversionFailure {
  if (!INT_TEXT.test(text)) return conversionError(text, 'int');
  const value = BigInt(text);
  return inInt64(value) ? value : conversionError(text, 'int');
}

function parseHexFloat(match: RegExpExecArray): number | undefined {
  const [, sign, whole, fraction = '', exponent] = match;
  if (whole.length + fraction.length === 0) return undefined;
  const mantissa = [...whole + fraction].reduce((acc, digit) => acc * 16 + parseInt(digit, 16), 0);
  const value = mantissa * 2 ** (Number(exponent) - 4 * fraction.length);
  return sign === '-' ? -value : value;
}

function parseFloatText(text: string): number | ConversionFailure {
  // Surrounding whitespace and control characters are allowed.
  const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  if (DECIMAL_FLOAT_TEXT.test(trimmed)) return parseFloat(trimmed.replace(/[fFdD]$/, ''));
  const hex = HEX_FLOAT_TEXT.exec(trimmed);
  const value = hex ? parseHexFloat(hex) : undefined;
  return value === undefined ? conversionError(text, 'float') : value;
}

const INT: Conversion = {
  overloads: 'int(int), int(float), int(string)',
  convert(value) {
    const int = rulesInt(value);
    if (int !== undefined) return int;
    const float = rulesFloatValue(value);
    if (float !== undefined) return truncateToInt(float);
    if (typeof value === 'string') return parseInt64(value);
    return unsupported('int', value, this.overloads);
  },
};

const FLOAT: Conversion = {
  overloads: 'float(int), float(float), float(string)',
  convert(value) {
    if (value instanceof RulesFloat) return value;
    const number = rulesNumberAsDouble(value);
    if (number !== undefined) return new RulesFloat(number);
    if (typeof value === 'string') {
      const parsed = parseFloatText(value);
      return typeof parsed === 'number' ? new RulesFloat(parsed) : parsed;
    }
    return unsupported('float', value, this.overloads);
  },
};

const STRING: Conversion = {
  overloads: 'string(int), string(float), string(null), string(string), string(bool), string(path)',
  convert(value) {
    if (typeof value === 'string') return value;
    // A float prints in its rules form, a host number past 2^53 included
    // (`9.007199254740992E15`); an int prints every digit.
    const float = rulesFloatValue(value);
    if (float !== undefined) return formatRulesFloat(float);
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    // Both evaluators' path values print as `/seg/seg`.
    if (value instanceof RulesValue && value.typeName === 'path') return value.toString();
    if (value instanceof Reference) return value.toPath().toString();
    return unsupported('string', value, this.overloads);
  },
};

const CONVERSIONS: ReadonlyMap<string, Conversion> = new Map([
  ['int', INT],
  ['float', FLOAT],
  ['string', STRING],
]);

/** The conversion function a bare call name resolves to, if any. */
export function conversionFor(name: string): Conversion | undefined {
  return CONVERSIONS.get(name);
}

/** Apply a conversion to its evaluated arguments. */
export function applyConversion(conversion: Conversion, args: readonly unknown[]): unknown {
  if (args.length !== 1) {
    return new ConversionFailure(
      `Incorrect number of arguments. Received: ${args.length}. Expected: ${conversion.overloads}.`,
    );
  }
  return conversion.convert(args[0]);
}
