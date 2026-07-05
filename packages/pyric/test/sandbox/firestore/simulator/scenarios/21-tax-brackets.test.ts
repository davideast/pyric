/**
 * Scenario 21: US Federal Income Tax Bracket Verification
 *
 * Computation verification pattern: client computes tax, security rules
 * verify each intermediate step against a config document with pre-computed
 * bracket data. Same approach that made chess work — lookup document + verify.
 *
 * 2024 Single Filer Brackets:
 *   10% up to $11,600
 *   12% $11,601 – $47,150
 *   22% $47,151 – $100,525
 *   24% $100,526 – $191,950
 *   32% $191,951 – $243,725
 *   35% $243,726 – $609,350
 *   37% over $609,350
 *
 * Standard deduction (single): $14,600
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

// ═══ Config document — bracket boundaries, rates, precomputed max taxes ═══

const TAX_CONFIG = {
  sdSingle: 14600,
  sdMarried: 29200,
  sdHead: 21900,
  b1Max: 11600,  b1Rate: 10,  b1Tax: 1160,
  b2Max: 47150,  b2Rate: 12,  b2Tax: 4266,
  b3Max: 100525, b3Rate: 22,  b3Tax: 11742.5,
  b4Max: 191950, b4Rate: 24,  b4Tax: 21942,
  b5Max: 243725, b5Rate: 32,  b5Tax: 16568,
  b6Max: 609350, b6Rate: 35,  b6Tax: 127968.75,
  b7Rate: 37,
};

// ═══ Bracket boundaries for computeTax helper ═══

const BRACKETS = [
  { max: 11600,  rate: 10 },
  { max: 47150,  rate: 12 },
  { max: 100525, rate: 22 },
  { max: 191950, rate: 24 },
  { max: 243725, rate: 32 },
  { max: 609350, rate: 35 },
  { max: Infinity, rate: 37 },
];

/**
 * Compute all bracket taxes for a given gross income (single filer).
 * Returns the full tax return document shape.
 */
function computeTax(grossIncome: number, userId = 'alice'): Record<string, unknown> {
  const standardDeduction = 14600;
  const taxableIncome = Math.max(0, grossIncome - standardDeduction);

  const bracketTaxes = [0, 0, 0, 0, 0, 0, 0];
  let remaining = taxableIncome;
  let floor = 0;

  for (let i = 0; i < BRACKETS.length; i++) {
    const bracket = BRACKETS[i];
    if (remaining <= 0) break;

    const bracketWidth = bracket.max === Infinity
      ? remaining
      : bracket.max - floor;
    const taxableInBracket = Math.min(remaining, bracketWidth);
    bracketTaxes[i] = taxableInBracket * bracket.rate / 100;
    remaining -= taxableInBracket;
    floor = bracket.max;
  }

  const totalTax = bracketTaxes.reduce((sum, t) => sum + t, 0);

  return {
    userId,
    filingStatus: 'single',
    grossIncome,
    standardDeduction,
    taxableIncome,
    b1Tax: bracketTaxes[0],
    b2Tax: bracketTaxes[1],
    b3Tax: bracketTaxes[2],
    b4Tax: bracketTaxes[3],
    b5Tax: bracketTaxes[4],
    b6Tax: bracketTaxes[5],
    b7Tax: bracketTaxes[6],
    totalTax,
    status: 'filed',
  };
}

// ═══ Rules — full implementation ═══

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function cfg() {
      return get(/databases/$(database)/documents/tax_config/2024).data;
    }

    function validDeduction(ret, config) {
      return ret.filingStatus == 'single'
        && ret.standardDeduction == config.sdSingle
        && ret.taxableIncome == ret.grossIncome - ret.standardDeduction;
    }

    function verifyB1(ret, config) {
      return ret.taxableIncome > config.b1Max
        ? ret.b1Tax == config.b1Tax
        : ret.b1Tax == ret.taxableIncome * config.b1Rate / 100;
    }

    function verifyB2(ret, config) {
      return ret.taxableIncome > config.b2Max
        ? ret.b2Tax == config.b2Tax
        : (ret.taxableIncome > config.b1Max
           ? ret.b2Tax == (ret.taxableIncome - config.b1Max) * config.b2Rate / 100
           : ret.b2Tax == 0);
    }

    function verifyB3(ret, config) {
      return ret.taxableIncome > config.b3Max
        ? ret.b3Tax == config.b3Tax
        : (ret.taxableIncome > config.b2Max
           ? ret.b3Tax == (ret.taxableIncome - config.b2Max) * config.b3Rate / 100
           : ret.b3Tax == 0);
    }

    function verifyB4(ret, config) {
      return ret.taxableIncome > config.b4Max
        ? ret.b4Tax == config.b4Tax
        : (ret.taxableIncome > config.b3Max
           ? ret.b4Tax == (ret.taxableIncome - config.b3Max) * config.b4Rate / 100
           : ret.b4Tax == 0);
    }

    function verifyB5(ret, config) {
      return ret.taxableIncome > config.b5Max
        ? ret.b5Tax == config.b5Tax
        : (ret.taxableIncome > config.b4Max
           ? ret.b5Tax == (ret.taxableIncome - config.b4Max) * config.b5Rate / 100
           : ret.b5Tax == 0);
    }

    function verifyB6(ret, config) {
      return ret.taxableIncome > config.b6Max
        ? ret.b6Tax == config.b6Tax
        : (ret.taxableIncome > config.b5Max
           ? ret.b6Tax == (ret.taxableIncome - config.b5Max) * config.b6Rate / 100
           : ret.b6Tax == 0);
    }

    function verifyB7(ret, config) {
      return ret.taxableIncome > config.b6Max
        ? ret.b7Tax == (ret.taxableIncome - config.b6Max) * config.b7Rate / 100
        : ret.b7Tax == 0;
    }

    function verifyTotal(ret) {
      return ret.totalTax == ret.b1Tax + ret.b2Tax + ret.b3Tax
                           + ret.b4Tax + ret.b5Tax + ret.b6Tax + ret.b7Tax;
    }

    function verifyReturn(ret) {
      let c = cfg();
      return validDeduction(ret, c)
        && verifyB1(ret, c)
        && verifyB2(ret, c)
        && verifyB3(ret, c)
        && verifyB4(ret, c)
        && verifyB5(ret, c)
        && verifyB6(ret, c)
        && verifyB7(ret, c)
        && verifyTotal(ret);
    }

    match /tax_config/{year} {
      allow read: if true;
      allow write: if false;
    }

    match /tax_returns/{returnId} {
      allow read: if request.auth != null
        && request.auth.uid == resource.data.userId;

      allow create: if request.resource.data.filingStatus == 'single'
        && request.auth != null
        && request.resource.data.userId == request.auth.uid
        && request.resource.data.status == 'filed'
        && verifyReturn(request.resource.data);

      allow update: if false;
      allow delete: if false;
    }
  }
}`;

function makeEnv() {
  const env = new LocalEnvironment();
  env.seed({
    rules: RULES,
    documents: {
      'tax_config/2024': TAX_CONFIG,
      'tax_returns/existing1': {
        userId: 'alice',
        filingStatus: 'single',
        grossIncome: 50000,
        standardDeduction: 14600,
        taxableIncome: 35400,
        b1Tax: 1160,
        b2Tax: 2856,
        b3Tax: 0,
        b4Tax: 0,
        b5Tax: 0,
        b6Tax: 0,
        b7Tax: 0,
        totalTax: 4016,
        status: 'filed',
      },
    },
  });
  return env;
}

describe('Scenario 21: US Federal Tax Bracket Verification', () => {

  // ═══ Category 1: Standard Deduction (3 tests) ═══

  test('1. correct standard deduction for single filer', () => {
    const env = makeEnv();
    const data = computeTax(85000);
    const r = env.execute({ method: 'create', path: 'tax_returns/r1', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('2. wrong standard deduction rejected', () => {
    const env = makeEnv();
    const data = { ...computeTax(85000), standardDeduction: 15000, taxableIncome: 70000 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r2', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('3. wrong taxable income rejected', () => {
    const env = makeEnv();
    const data = { ...computeTax(85000), taxableIncome: 70000 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r3', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  // ═══ Category 2: Single Bracket Income (3 tests) ═══

  test('4. income in bracket 1 only ($20k gross)', () => {
    const env = makeEnv();
    const data = computeTax(20000);
    const r = env.execute({ method: 'create', path: 'tax_returns/r4', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('5. taxable income exactly at bracket 1 boundary', () => {
    const env = makeEnv();
    // grossIncome = 11600 + 14600 = 26200 → taxableIncome = 11600
    const data = computeTax(26200);
    expect(data.taxableIncome).toBe(11600);
    expect(data.b1Tax).toBe(1160);
    expect(data.b2Tax).toBe(0);
    const r = env.execute({ method: 'create', path: 'tax_returns/r5', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('6. taxable income is zero (gross equals deduction)', () => {
    const env = makeEnv();
    const data = computeTax(14600);
    expect(data.taxableIncome).toBe(0);
    expect(data.totalTax).toBe(0);
    const r = env.execute({ method: 'create', path: 'tax_returns/r6', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  // ═══ Category 3: Multi-Bracket Income (4 tests) ═══

  test('7. income straddles brackets 1-2 ($30k taxable)', () => {
    const env = makeEnv();
    // grossIncome = 30000 + 14600 = 44600
    const data = computeTax(44600);
    expect(data.taxableIncome).toBe(30000);
    const r = env.execute({ method: 'create', path: 'tax_returns/r7', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('8. income straddles brackets 1-3 ($70,400 taxable)', () => {
    const env = makeEnv();
    const data = computeTax(85000);
    expect(data.taxableIncome).toBe(70400);
    const r = env.execute({ method: 'create', path: 'tax_returns/r8', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('9. income straddles brackets 1-5 ($200k taxable)', () => {
    const env = makeEnv();
    const data = computeTax(214600);
    expect(data.taxableIncome).toBe(200000);
    const r = env.execute({ method: 'create', path: 'tax_returns/r9', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('10. top bracket income ($1M taxable) — fractional bracket tax DENIED (int division)', () => {
    const env = makeEnv();
    const data = computeTax(1014600);
    expect(data.taxableIncome).toBe(1000000);
    const r = env.execute({ method: 'create', path: 'tax_returns/r10', auth: { uid: 'alice' }, data });
    // RULES-B5: prod computes `(income - prevMax) * rate / 100` with INT64
    // division (truncates); the JS-side computeTax carries sub-cent floats, so
    // the equality check fails and prod DENIES. The old `toBe(true)` asserted
    // the float-division bug as correct (self-referential masking test) — see
    // design rationale
    expect(r.allowed).toBe(false);
  });

  // ═══ Category 4: Bracket Boundary Values (4 tests) ═══

  test('11. income at bracket 2 max boundary ($47,150)', () => {
    const env = makeEnv();
    const data = computeTax(47150 + 14600);
    expect(data.taxableIncome).toBe(47150);
    expect(data.b3Tax).toBe(0);
    const r = env.execute({ method: 'create', path: 'tax_returns/r11', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(true);
  });

  test('12. one dollar into bracket 3 ($47,151)', () => {
    const env = makeEnv();
    const data = computeTax(47151 + 14600);
    expect(data.taxableIncome).toBe(47151);
    expect(data.b3Tax).toBe(0.22);
    const r = env.execute({ method: 'create', path: 'tax_returns/r12', auth: { uid: 'alice' }, data });
    // RULES-B5: rules-side `1 * 22 / 100` is int division → 0; `0.22 == 0` is
    // false → prod DENIES (was a self-referential masking test; see step-14 doc).
    expect(r.allowed).toBe(false);
  });

  test('13. income at bracket 6 max ($609,350)', () => {
    const env = makeEnv();
    const data = computeTax(609350 + 14600);
    expect(data.taxableIncome).toBe(609350);
    expect(data.b7Tax).toBe(0);
    const r = env.execute({ method: 'create', path: 'tax_returns/r13', auth: { uid: 'alice' }, data });
    // RULES-B5: b7Tax is 0, but bracket 6's tax is fractional (.75) at this
    // income — int division truncates rules-side, JS data carries the float →
    // mismatch → prod DENIES (see step-14 doc).
    expect(r.allowed).toBe(false);
  });

  test('14. one dollar into bracket 7 ($609,351)', () => {
    const env = makeEnv();
    const data = computeTax(609351 + 14600);
    expect(data.taxableIncome).toBe(609351);
    expect(data.b7Tax).toBe(0.37);
    const r = env.execute({ method: 'create', path: 'tax_returns/r14', auth: { uid: 'alice' }, data });
    // RULES-B5: rules-side `1 * 37 / 100` is int division → 0; `0.37 == 0` is
    // false → prod DENIES (was a self-referential masking test; see step-14 doc).
    expect(r.allowed).toBe(false);
  });

  // ═══ Category 5: Wrong Computation Rejected (7 tests) ═══

  test('15. wrong b1Tax rejected', () => {
    const env = makeEnv();
    const data = { ...computeTax(85000), b1Tax: 1100 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r15', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('16. wrong b2Tax rejected', () => {
    const env = makeEnv();
    const data = { ...computeTax(85000), b2Tax: 4200 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r16', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('17. wrong b3Tax rejected', () => {
    const env = makeEnv();
    const data = { ...computeTax(85000), b3Tax: 5000 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r17', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('18. wrong b4Tax rejected', () => {
    const env = makeEnv();
    // Use income that reaches bracket 4
    const data = { ...computeTax(200000), b4Tax: 999 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r18', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('19. wrong b5Tax rejected', () => {
    const env = makeEnv();
    // Use income that reaches bracket 5
    const data = { ...computeTax(260000), b5Tax: 999 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r19', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('20. wrong b7Tax rejected (top bracket)', () => {
    const env = makeEnv();
    const data = { ...computeTax(1014600), b7Tax: 999 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r20', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('21. wrong totalTax (bracket taxes correct, sum wrong)', () => {
    const env = makeEnv();
    const data = { ...computeTax(85000), totalTax: 99999 };
    const r = env.execute({ method: 'create', path: 'tax_returns/r21', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  // ═══ Category 6: Auth Enforcement (3 tests) ═══

  test('22. unauthenticated user rejected', () => {
    const env = makeEnv();
    const data = computeTax(85000);
    const r = env.execute({ method: 'create', path: 'tax_returns/r22', auth: null, data });
    expect(r.allowed).toBe(false);
  });

  test('23. wrong userId rejected', () => {
    const env = makeEnv();
    const data = computeTax(85000, 'bob');
    const r = env.execute({ method: 'create', path: 'tax_returns/r23', auth: { uid: 'alice' }, data });
    expect(r.allowed).toBe(false);
  });

  test('24. owner can read own return', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'tax_returns/existing1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
    expect(r.data).toBeDefined();
  });

  // ═══ Category 7: Config & Immutability (4 tests) ═══

  test('25. config doc cannot be written', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'tax_config/2025', auth: { uid: 'admin' }, data: { b1Max: 12000 } });
    expect(r.allowed).toBe(false);
  });

  test('26. filed return cannot be updated', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'tax_returns/existing1', auth: { uid: 'alice' }, data: { totalTax: 0 } });
    expect(r.allowed).toBe(false);
  });

  test('27. filed return cannot be deleted', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'tax_returns/existing1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('28. non-owner cannot read return', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'tax_returns/existing1', auth: { uid: 'bob' } });
    expect(r.allowed).toBe(false);
  });
});
