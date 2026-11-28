// Embedded Unicode simple case-folding orbits and RE2 general category tables
// for standalone zero-dependency ES module RE2 matching (pure 7-bit ASCII).
export const boundedRe2FoldRuntime = `  const RE2_GEN_CATS = new Set([
    'C','Cc','Cf','Co','Cs','L','Ll','Lm','Lo','Lt','Lu','M','Mc','Me','Mn',
    'N','Nd','Nl','No','P','Pc','Pd','Pe','Pf','Pi','Po','Ps','S','Sc','Sk',
    'Sm','So','Z','Zl','Zp','Zs','Any',
  ]);
  const RE2_SHORT_CATS = new Set(['C','L','M','N','P','S','Z']);
  const RE2_ORBIT_MAP = (() => {
    const groups = [
      [0x004b,0x006b,0x212a],[0x0053,0x0073,0x017f],[0x00b5,0x039c,0x03bc],
      [0x00c5,0x00e5,0x212b],[0x01c4,0x01c5,0x01c6],[0x01c7,0x01c8,0x01c9],
      [0x01ca,0x01cb,0x01cc],[0x01f1,0x01f2,0x01f3],[0x1e60,0x1e61,0x1e9b],
      [0x0345,0x0399,0x03b9,0x1fbe],[0x0392,0x03b2,0x03d0],[0x0395,0x03b5,0x03f5],
      [0x0398,0x03b8,0x03d1,0x03f4],[0x039a,0x03ba,0x03f0],[0x03a0,0x03c0,0x03d6],
      [0x03a1,0x03c1,0x03f1],[0x03a3,0x03c2,0x03c3],[0x03a6,0x03c6,0x03d5],
      [0x03a9,0x03c9,0x2126],[0x0412,0x0432,0x1c80],[0x0414,0x0434,0x1c81],
      [0x041e,0x043e,0x1c82],[0x0421,0x0441,0x1c83],[0x0422,0x0442,0x1c84,0x1c85],
      [0x042a,0x044a,0x1c86],[0x0462,0x0463,0x1c87],[0xa64a,0xa64b,0x1c88],
      [0x00df,0x1e9e],[0x0390,0x1fd3],[0x03b0,0x1fe3],[0x1fb3,0x1fbc],
      [0x1fc3,0x1fcc],[0x1ff3,0x1ffc],[0xfb05,0xfb06],
    ];
    for (const base of [0x1f80, 0x1f90, 0x1fa0]) {
      for (let i = 0; i < 8; i++) groups.push([base + i, base + 8 + i]);
    }
    const map = new Map();
    for (const cps of groups) {
      const chars = cps.map((cp) => String.fromCodePoint(cp));
      for (const ch of chars) map.set(ch, chars);
    }
    return map;
  })();
  const re2PairCache = new Map();
  function re2Orbit(ch) {
    const special = RE2_ORBIT_MAP.get(ch);
    if (special !== undefined) return special;
    const cached = re2PairCache.get(ch);
    if (cached !== undefined) return cached;
    const lo = ch.toLowerCase();
    if (lo !== ch && Array.from(lo).length === 1 && lo.toUpperCase() === ch) {
      const pair = [ch, lo];
      re2PairCache.set(ch, pair);
      re2PairCache.set(lo, pair);
      return pair;
    }
    const up = ch.toUpperCase();
    if (up !== ch && Array.from(up).length === 1 && up.toLowerCase() === ch) {
      const pair = [ch, up];
      re2PairCache.set(ch, pair);
      re2PairCache.set(up, pair);
      return pair;
    }
    const single = [ch];
    re2PairCache.set(ch, single);
    return single;
  }
`;
