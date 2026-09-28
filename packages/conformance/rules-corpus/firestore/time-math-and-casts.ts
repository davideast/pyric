/**
 * ─── Scenario: time-math-and-casts ────────────────────────────────────────────
 * The request.time Timestamp accessor family (year/month/day/hours/minutes/
 * seconds/nanos/dayOfWeek/dayOfYear/toMillis/date/time), the math.* builtins
 * (floor/round/sqrt/pow/isNaN), the numeric/string type casts (int/float/string),
 * request.method, and the `>=` / `*` operators — the arithmetic and temporal
 * surface a validation-heavy `events` write leans on. request.time is pinned via
 * `requestTime` so the temporal assertions are deterministic across runs.
 *
 * The conversion cases pin `int()`, `float()`, and `string()` one condition per
 * path. `int(string)` parses the whole string as a signed 64-bit decimal
 * integer: whitespace, a fraction, an exponent, hex, and out-of-range values
 * are a "Type conversion error". `int(float)` truncates toward zero, saturates
 * at the int64 bounds, and maps NaN to 0. `float(string)` accepts Java double
 * syntax. `string()` accepts int, float, null, string, bool, and path, and
 * prints a float as Java's `Double.toString` does: `4.9E-324` for the
 * smallest subnormal, not the shortest form `5.0E-324`. Every conversion
 * failure is an error value: it denies through `!=`, and `|| true` absorbs it.
 *
 * The math cases (packages/conformance/src/rules-math-cases.ts, shared with
 * the Storage scenario `math-namespace`) pin the namespace's result types:
 * `math.abs()` keeps its argument's type, `math.ceil()` and `math.floor()`
 * return a float, `math.round()` rounds half up to an int, and
 * `math.sqrt()` and `math.pow()` return a float. A wrong argument type or
 * count, and `math.isInfinite()`, are error values.
 */
import { MATH_CASES } from '../../src/rules-math-cases.ts';
import type { ScenarioRecord, TestCase } from './types.ts';

interface ConversionCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
}

const conversions: ConversionCase[] = [
  { key: 'intFromString', condition: "int('12') == 12 && int('-3') == -3 && int('+3') == 3 && int('-0') == 0 && int('12') is int", expectation: 'ALLOW' },
  { key: 'intFromFloatTruncates', condition: 'int(1.9) == 1 && int(-1.9) == -1 && int(2.5) is int', expectation: 'ALLOW' },
  { key: 'intFromFloatSaturates', condition: "int(float('9.3e18')) == 9223372036854775807 && int(float('-9.3e18')) == -9223372036854775808 && int(float('NaN')) == 0", expectation: 'ALLOW' },
  { key: 'intInt64Max', condition: 'int(9223372036854775807) == 9223372036854775807', expectation: 'ALLOW' },
  { key: 'intDecimalString', condition: "int('1.5') != 0", expectation: 'DENY' },
  { key: 'intDecimalStringOrTrue', condition: "(int('1.5') == 0) || true", expectation: 'ALLOW' },
  { key: 'intHexString', condition: "int('0x10') != 0", expectation: 'DENY' },
  { key: 'intSurroundingSpaces', condition: "int(' 1 ') != 1", expectation: 'DENY' },
  { key: 'intExponentString', condition: "int('1e3') != 0", expectation: 'DENY' },
  { key: 'intOverflow', condition: "int('9223372036854775808') != 0", expectation: 'DENY' },
  { key: 'intBool', condition: 'int(true) != 0', expectation: 'DENY' },
  { key: 'intBoolOrTrue', condition: '(int(true) == 1) || true', expectation: 'ALLOW' },
  { key: 'intNull', condition: 'int(null) != 0', expectation: 'DENY' },
  { key: 'intTwoArgs', condition: "int('1', 2) == 1", expectation: 'DENY' },
  { key: 'floatStringForms', condition: "float('1e3') == 1000.0 && float('.5') == 0.5 && float('5.') == 5.0 && float('1.5f') == 1.5 && float('1.5d') == 1.5 && float('0x1p3') == 8.0 && float(' 2.5') == 2.5 && float('2.5 ') == 2.5", expectation: 'ALLOW' },
  { key: 'floatStringSpecial', condition: "float('NaN') != float('NaN') && float('Infinity') > 1.0 && float('-Infinity') < 1.0", expectation: 'ALLOW' },
  { key: 'floatFromNumbers', condition: 'float(2) is float && float(2) == 2.0 && float(1.5) is float && float(1.5) == 1.5', expectation: 'ALLOW' },
  { key: 'floatInf', condition: "float('inf') > 1.0", expectation: 'DENY' },
  { key: 'floatLowercaseNan', condition: "float('nan') != 0.0", expectation: 'DENY' },
  { key: 'floatText', condition: "float('abc') != 0.0", expectation: 'DENY' },
  { key: 'floatTextOrTrue', condition: "(float('abc') == 0.0) || true", expectation: 'ALLOW' },
  { key: 'floatBool', condition: 'float(true) != 0.0', expectation: 'DENY' },
  { key: 'floatNull', condition: 'float(null) != 0.0', expectation: 'DENY' },
  { key: 'stringFromScalars', condition: "string(true) == 'true' && string(null) == 'null' && string('s') == 's' && string(12) == '12' && string(path('a/b')) == '/a/b'", expectation: 'ALLOW' },
  { key: 'stringFromFloat', condition: "string(1.0) == '1.0' && string(float(2)) == '2.0' && string(0.1 + 0.2) == '0.30000000000000004' && string(1.0 / 3.0) == '0.3333333333333333' && string(-0.0) == '-0.0'", expectation: 'ALLOW' },
  { key: 'stringFromFloatScientific', condition: "string(float('1e7')) == '1.0E7' && string(float('1e-4')) == '1.0E-4' && string(123456789.0) == '1.23456789E8' && string(float('1e21')) == '1.0E21' && string(float('2e-3')) == '0.002' && string(float('NaN')) == 'NaN' && string(float('-Infinity')) == '-Infinity'", expectation: 'ALLOW' },
  { key: 'stringFromFloatSubnormal', condition: "string(float('4.9e-324')) == '4.9E-324' && string(float('-4.9e-324')) == '-4.9E-324' && string(float('1e-323')) == '9.9E-324' && string(float('2e-323')) == '2.0E-323' && string(float('1e-322')) == '9.9E-323' && string(float('1e-310')) == '1.0E-310'", expectation: 'ALLOW' },
  { key: 'stringFromFloatSubnormalNot', condition: "string(float('4.9e-324')) != '4.9E-324'", expectation: 'DENY' },
  { key: 'stringFromFloatSubnormalShortest', condition: "string(float('4.9e-324')) == '5.0E-324'", expectation: 'DENY' },
  { key: 'stringFromList', condition: "string([1]) != ''", expectation: 'DENY' },
  { key: 'stringFromListOrTrue', condition: "(string([1]) == '') || true", expectation: 'ALLOW' },
  { key: 'stringFromMap', condition: "string({'a': 1}) != ''", expectation: 'DENY' },
  { key: 'stringFromBytes', condition: "string(b'abc') != ''", expectation: 'DENY' },
  { key: 'stringFromDuration', condition: "string(duration.value(1, 's')) != ''", expectation: 'DENY' },
];

function conversionCase({ key, condition, expectation }: ConversionCase): TestCase {
  return {
    description: `${condition} → ${expectation}`,
    expectation,
    method: 'create',
    path: `${key}/d`,
    auth: { uid: 'alice' },
    data: { _: 1 },
  };
}

const conversionBlocks = [...conversions, ...MATH_CASES]
  .map(({ key, condition }) => `    match /${key}/{id} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Coverage: Timestamp methods + math builtins + casts',
  rationale:
    'Production must accept request.time.<accessor>() Timestamp methods, math.floor/round/sqrt/pow/isNaN, int/float/string casts, request.method, and >= / * operators; int() parses a whole int64 decimal string and truncates or saturates a float, float() parses Java double syntax, string() prints a float as Java Double.toString does, math.ceil/floor/sqrt/pow return a float, math.round returns an int, and every conversion or math failure is an error value that || true absorbs.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{eventId} {
      allow create: if request.auth != null
        && request.method == 'create'
        && request.time.year() >= 2020
        && request.time.month() >= 1
        && request.time.day() >= 1
        && request.time.hours() >= 0
        && request.time.minutes() >= 0
        && request.time.seconds() >= 0
        && request.time.nanos() >= 0
        && request.time.dayOfWeek() >= 1
        && request.time.dayOfYear() >= 1
        && request.time.toMillis() > 0
        && request.time.date() == request.time.date()
        && request.time.time() == request.time.time()
        && math.floor(request.resource.data.score) >= 0
        && math.round(request.resource.data.score) >= 0
        && math.sqrt(request.resource.data.area) >= 0
        && math.pow(request.resource.data.base, 2) >= 0
        && math.isNaN(request.resource.data.score) == false
        && int(request.resource.data.countStr) >= 0
        && float(request.resource.data.countStr) >= 0
        && string(request.resource.data.score).size() >= 1
        && request.resource.data.qty * 2 >= 2;
    }
${conversionBlocks}
  }
}`,
  cases: [
    {
      description: 'valid event within all bounds ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'events/e1',
      auth: { uid: 'alice' },
      requestTime: '2023-06-15T12:30:45.000Z',
      data: { score: 4, area: 9, base: 3, countStr: '5', qty: 2 },
    },
    {
      description: 'qty too small so qty*2 < 2 DENY (mul + gte)',
      expectation: 'DENY',
      method: 'create',
      path: 'events/e2',
      auth: { uid: 'alice' },
      requestTime: '2023-06-15T12:30:45.000Z',
      data: { score: 4, area: 9, base: 3, countStr: '5', qty: 0 },
    },
    {
      description: 'negative area so sqrt precondition fails DENY (math.sqrt)',
      expectation: 'DENY',
      method: 'create',
      path: 'events/e3',
      auth: { uid: 'alice' },
      requestTime: '2023-06-15T12:30:45.000Z',
      data: { score: 4, area: -1, base: 3, countStr: '5', qty: 2 },
    },
    ...conversions.map(conversionCase),
    ...MATH_CASES.map(conversionCase),
  ],
  group: 'stress',
};
