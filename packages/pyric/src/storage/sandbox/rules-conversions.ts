import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { StoragePath } from './rules-path.js';
import { RuleError, describeRulesType as describeType } from './rules-values.js';

/**
 * The global conversion functions of the Storage rules language: `int()`,
 * `string()`, and `float()`. Corpus scenario `conversion-functions` records
 * the production verdicts. Every failure is an error value, so `&&` and `||`
 * can absorb it. Production has no global `bool()`, so a `bool` call resolves
 * to the Function not found error value (corpus scenario `bool-function`).
 */
interface Conversion {
  /** The overload list production prints in its argument errors. */
  readonly overloads: string;
  convert(value: unknown): unknown;
}

const INT64_MIN = -(2 ** 63);
const INT64_MAX = 2 ** 63;
const INT64_MIN_BIG = -(2n ** 63n);
const INT64_MAX_BIG = 2n ** 63n - 1n;

// A whole decimal string with an optional sign: no whitespace, fraction, or
// radix prefix.
const INT_TEXT = /^[+-]?\d+$/;
// Decimal float text with an optional exponent and an f or d suffix, plus
// the NaN and Infinity spellings.
const DECIMAL_FLOAT_TEXT = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;
// Hexadecimal float text: mantissa digits, a binary exponent, and an optional
// f or d suffix.
const HEX_FLOAT_TEXT = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)[fFdD]?$/;

function conversionError(text: string, to: 'int' | 'float'): RuleError {
  return new RuleError(
    `Type conversion error. Argument: [${text}], From type: [string], To type: [${to}].`,
  );
}

function unsupported(name: string, value: unknown, overloads: string): RuleError {
  return new RuleError(
    `Unsupported operation error. Received: ${name}(${describeType(value)}). Expected: ${overloads}.`,
  );
}

/** A float truncated toward zero, saturated at the int64 bounds, NaN as 0. */
function truncateToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value <= INT64_MIN) return INT64_MIN;
  if (value >= INT64_MAX) return INT64_MAX;
  return Math.trunc(value) + 0; // + 0 turns -0 into 0
}

function parseInt64(text: string): number | RuleError {
  if (!INT_TEXT.test(text)) return conversionError(text, 'int');
  const value = BigInt(text);
  if (value < INT64_MIN_BIG || value > INT64_MAX_BIG) return conversionError(text, 'int');
  return Number(value);
}

function parseHexFloat(match: RegExpExecArray): number | undefined {
  const [, sign, whole, fraction = '', exponent] = match;
  if (whole.length + fraction.length === 0) return undefined;
  const mantissa = [...whole + fraction].reduce((acc, digit) => acc * 16 + parseInt(digit, 16), 0);
  const value = mantissa * 2 ** (Number(exponent) - 4 * fraction.length);
  return sign === '-' ? -value : value;
}

function parseFloatText(text: string): number | RuleError {
  // Surrounding whitespace and control characters are allowed.
  const trimmed = text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  if (DECIMAL_FLOAT_TEXT.test(trimmed)) return parseFloat(trimmed.replace(/[fFdD]$/, ''));
  const hex = HEX_FLOAT_TEXT.exec(trimmed);
  const value = hex ? parseHexFloat(hex) : undefined;
  return value === undefined ? conversionError(text, 'float') : value;
}

/**
 * A float as production prints it: at least one fractional digit, plain
 * decimal for a magnitude in [1e-3, 1e7), and `<digits>E<exponent>` outside
 * that range, with the shortest digits that identify the value.
 */
export function formatRulesFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-3 && magnitude < 1e7) {
    const text = String(value);
    return text.includes('.') ? text : `${text}.0`;
  }
  const [digits, exponent] = value.toExponential().split('e');
  const mantissa = digits.includes('.') ? digits : `${digits}.0`;
  return `${mantissa}E${Number(exponent)}`;
}

const INT: Conversion = {
  overloads: 'int(int), int(float), int(string)',
  convert(value) {
    if (typeof value === 'number') return value;
    if (value instanceof RulesFloat) return truncateToInt(value.value);
    if (typeof value === 'string') return parseInt64(value);
    return unsupported('int', value, this.overloads);
  },
};

const FLOAT: Conversion = {
  overloads: 'float(int), float(float), float(string)',
  convert(value) {
    if (value instanceof RulesFloat) return value;
    if (typeof value === 'number') return new RulesFloat(value);
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
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    if (value instanceof RulesFloat) return formatRulesFloat(value.value);
    if (value instanceof StoragePath) return value.toString();
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
export function applyConversion(conversion: Conversion, args: unknown[]): unknown {
  if (args.length !== 1) {
    return new RuleError(
      `Incorrect number of arguments. Received: ${args.length}. Expected: ${conversion.overloads}.`,
    );
  }
  return conversion.convert(args[0]);
}
