/**
 * Browser-clean static evaluation of `Uint8Array` / typed arrays, `ArrayBuffer`,
 * `Blob`, `TextEncoder#encode`, and base64 byte sequences without `Buffer`.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { alternatives, lit, literalText, ownRecordValue, type AVal, type Env } from './values.js';

const UTF8_ENCODER = new TextEncoder();

const TYPED_ARRAY_ELEMENT_BYTES: Readonly<Record<string, number>> = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
  BigInt64Array: 8,
  BigUint64Array: 8,
};

export const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_TRACKED_QUERY_BYTES = 1024;
const UINT8_LITERAL_BYTES = new WeakMap<Extract<AVal, { k: 'obj' }>, readonly number[]>();

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}

export function literalUint8Bytes(val: AVal): readonly number[] | undefined {
  if (val.k === 'obj') return UINT8_LITERAL_BYTES.get(val);
  return undefined;
}

export function decodeBase64Bytes(raw: string): number[] | undefined {
  const clean = raw.replace(/[\t\n\r ]+/g, '');
  if (clean.length === 0) return [];
  if (clean.length % 4 !== 0 || !BASE64_RE.test(clean)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]!);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1]!);
    const ch2 = clean[i + 2]!;
    const ch3 = clean[i + 3]!;
    let c2 = 0;
    if (ch2 !== '=') c2 = BASE64_ALPHABET.indexOf(ch2);
    let c3 = 0;
    if (ch3 !== '=') c3 = BASE64_ALPHABET.indexOf(ch3);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return undefined;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((triple >> 16) & 0xff);
    if (ch2 !== '=') out.push((triple >> 8) & 0xff);
    if (ch3 !== '=') out.push(triple & 0xff);
    if (out.length > MAX_TRACKED_QUERY_BYTES) return undefined;
  }
  return out;
}

function closedObj(entries: readonly [string, AVal][]): AVal {
  return {
    k: 'obj',
    props: new Map(entries),
    computed: [],
    open: false,
    optional: new Set(),
  };
}

function exactNonNegativeInt(v: AVal): number | undefined {
  if (v.k === 'num' && v.value !== undefined && Number.isInteger(v.value) && v.value >= 0) {
    return v.value;
  }
  return undefined;
}

function hasUnknownArraySpread(ev: Evaluator, expr: ts.Expression, env: Env | undefined): boolean {
  if (!ts.isArrayLiteralExpression(expr)) return false;
  for (const el of expr.elements) {
    if (!ts.isSpreadElement(el)) continue;
    const spreadVal = ev.force(ev.eval(el.expression, env));
    const alts = alternatives(spreadVal);
    if (alts.length !== 1 || alts[0]!.k !== 'arr' || alts[0]!.open) return true;
  }
  return false;
}

function attachUint8Bytes(
  obj: AVal,
  bytes: readonly number[] | undefined,
): AVal {
  if (bytes !== undefined && obj.k === 'obj') {
    UINT8_LITERAL_BYTES.set(obj, bytes);
  }
  return obj;
}

function extractUint8ArrayBytes(
  ev: Evaluator,
  items: readonly AVal[],
): number[] | undefined {
  if (items.length > MAX_TRACKED_QUERY_BYTES) return undefined;
  const bytes: number[] = [];
  for (const item of items) {
    const forced = ev.force(item);
    if (forced.k !== 'num' || forced.value === undefined || !Number.isFinite(forced.value)) {
      return undefined;
    }
    bytes.push(((Math.trunc(forced.value) % 256) + 256) % 256);
  }
  return bytes;
}

function evalTypedArrayOrBuffer(
  ev: Evaluator,
  name: string,
  args: readonly ts.Expression[],
  env: Env | undefined,
): AVal | undefined {
  if (name === 'TextEncoder') {
    return {
      k: 'obj',
      props: new Map([['__textEncoder', { k: 'bool', value: true }]]),
      computed: [],
      open: true,
      optional: new Set(),
    };
  }
  if (name === 'ArrayBuffer') {
    let first: AVal = { k: 'num', value: 0 };
    if (args[0] && !ts.isSpreadElement(args[0])) {
      first = ev.force(ev.eval(args[0], env));
    } else if (args[0]) {
      first = { k: 'num' };
    }
    const exact = exactNonNegativeInt(first);
    let lenVal: AVal = { k: 'num' };
    if (exact !== undefined) lenVal = { k: 'num', value: exact };
    return closedObj([['byteLength', lenVal]]);
  }
  const elemBytes = ownRecordValue(TYPED_ARRAY_ELEMENT_BYTES, name);
  if (elemBytes === undefined) return undefined;
  if (args.length === 0) {
    let emptyBytes: number[] | undefined;
    if (name === 'Uint8Array') emptyBytes = [];
    return attachUint8Bytes(
      closedObj([
        ['byteLength', { k: 'num', value: 0 }],
        ['length', { k: 'num', value: 0 }],
      ]),
      emptyBytes,
    );
  }
  const firstExpr = args[0]!;
  if (!ts.isSpreadElement(firstExpr)) {
    const first = ev.force(ev.eval(firstExpr, env));
    const exactCount = exactNonNegativeInt(first);
    if (exactCount !== undefined) {
      let zeroBytes: number[] | undefined;
      if (name === 'Uint8Array' && exactCount <= MAX_TRACKED_QUERY_BYTES) {
        zeroBytes = new Array<number>(exactCount).fill(0);
      }
      return attachUint8Bytes(
        closedObj([
          ['byteLength', { k: 'num', value: exactCount * elemBytes }],
          ['length', { k: 'num', value: exactCount }],
        ]),
        zeroBytes,
      );
    }
    if (first.k === 'arr' && !first.open && !hasUnknownArraySpread(ev, firstExpr, env)) {
      const count = first.items.length;
      let arrBytes: number[] | undefined;
      if (name === 'Uint8Array') arrBytes = extractUint8ArrayBytes(ev, first.items);
      return attachUint8Bytes(
        closedObj([
          ['byteLength', { k: 'num', value: count * elemBytes }],
          ['length', { k: 'num', value: count }],
        ]),
        arrBytes,
      );
    }
    if (args.length === 1 && first.k === 'obj') {
      const bufLen = first.props.get('byteLength');
      let exactBuf: number | undefined;
      if (bufLen) exactBuf = exactNonNegativeInt(ev.force(bufLen));
      if (exactBuf !== undefined) {
        let copiedBytes: readonly number[] | undefined;
        if (name === 'Uint8Array') copiedBytes = literalUint8Bytes(first);
        return attachUint8Bytes(
          closedObj([
            ['byteLength', { k: 'num', value: exactBuf }],
            ['length', { k: 'num', value: Math.floor(exactBuf / elemBytes) }],
          ]),
          copiedBytes,
        );
      }
    }
  }
  return closedObj([
    ['byteLength', { k: 'num' }],
    ['length', { k: 'num' }],
  ]);
}

function evalBlobConstructor(
  ev: Evaluator,
  args: readonly ts.Expression[],
  env: Env | undefined,
): AVal {
  let totalBytes: number | undefined = 0;
  if (args[0] && !ts.isSpreadElement(args[0])) {
    const partsVal = ev.force(ev.eval(args[0], env));
    if (partsVal.k === 'arr' && !partsVal.open && !hasUnknownArraySpread(ev, args[0], env)) {
      for (const item of partsVal.items) {
        const forcedItem = ev.force(item);
        const itemText = literalText(forcedItem);
        if (itemText !== null) {
          totalBytes += utf8ByteLength(itemText);
          continue;
        }
        if (forcedItem.k === 'obj') {
          const rawLen = forcedItem.props.get('byteLength') ?? forcedItem.props.get('size');
          let exactLen: number | undefined;
          if (rawLen) exactLen = exactNonNegativeInt(ev.force(rawLen));
          if (exactLen !== undefined) {
            totalBytes += exactLen;
            continue;
          }
        }
        totalBytes = undefined;
        break;
      }
    } else {
      totalBytes = undefined;
    }
  } else if (args[0]) {
    totalBytes = undefined;
  }
  let sizeVal: AVal = { k: 'num' };
  if (totalBytes !== undefined) sizeVal = { k: 'num', value: totalBytes };
  const dynamicBlobType: AVal = { k: 'str', parts: [{ kind: 'hole', name: 'type', auth: [] }] };
  const entries: [string, AVal][] = [['size', sizeVal]];
  if (args[1]) {
    if (ts.isSpreadElement(args[1])) {
      entries.push(['type', dynamicBlobType]);
    } else {
      const optsAlts = alternatives(ev.force(ev.eval(args[1], env))).filter(
        (a) => a.k !== 'undefined' && a.k !== 'null',
      );
      if (optsAlts.some((a) => a.k !== 'obj')) {
        entries.push(['type', dynamicBlobType]);
      } else {
        const objOpts = optsAlts.filter((a): a is Extract<AVal, { k: 'obj' }> => a.k === 'obj');
        if (objOpts.length === 1 && !objOpts[0]!.open && objOpts[0]!.computed.length === 0) {
          const single = objOpts[0]!;
          if (single.props.has('type') && !single.optional.has('type')) {
            const typeText = literalText(ev.force(single.props.get('type')!));
            if (typeText !== null) {
              entries.push(['type', lit(typeText)]);
            } else {
              entries.push(['type', dynamicBlobType]);
            }
          } else if (single.props.has('type')) {
            entries.push(['type', dynamicBlobType]);
          }
        } else if (objOpts.length > 0) {
          entries.push(['type', dynamicBlobType]);
        }
      }
    }
  }
  return closedObj(entries);
}

/** Model typed arrays, `ArrayBuffer`, `Blob`, and `TextEncoder#encode` for static byte-length tracking. */
export function evalBinaryBuiltin(
  ev: Evaluator,
  node: ts.CallExpression | ts.NewExpression,
  env: Env | undefined,
): AVal | undefined {
  const callee = node.expression;
  const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  if (ts.isNewExpression(node) && ts.isIdentifier(callee)) {
    if (callee.text === 'Blob') return evalBlobConstructor(ev, args, env);
    return evalTypedArrayOrBuffer(ev, callee.text, args, env);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) && callee.name.text === 'encode') {
    const recv = ev.force(ev.eval(callee.expression, env));
    const isEncoder = alternatives(recv).some(
      (a) => a.k === 'obj' && a.props.get('__textEncoder')?.k === 'bool',
    );
    if (!isEncoder) return undefined;
    if (args.length === 0) {
      return closedObj([
        ['byteLength', { k: 'num', value: 0 }],
        ['length', { k: 'num', value: 0 }],
      ]);
    }
    const arg0 = args[0]!;
    if (!ts.isSpreadElement(arg0)) {
      const text = literalText(ev.force(ev.eval(arg0, env)));
      if (text !== null) {
        const n = utf8ByteLength(text);
        return closedObj([
          ['byteLength', { k: 'num', value: n }],
          ['length', { k: 'num', value: n }],
        ]);
      }
    }
    return closedObj([
      ['byteLength', { k: 'num' }],
      ['length', { k: 'num' }],
    ]);
  }
  return undefined;
}
