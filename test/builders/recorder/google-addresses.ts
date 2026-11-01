/**
 * Google's own address ranges, for a request a builder sends to an IP address
 * instead of a name. This is a subset of the ranges Google publishes in
 * goog.json: Google Public DNS and the front ends of Google's own services.
 * Google Cloud customer ranges (cloud.json) are left out, since an address
 * there is a customer's machine, not a Google API.
 *
 * Addresses arrive in `normalizeHostname`'s spelling: a dotted quad for every
 * IPv4 form (IPv4-mapped IPv6 included), and compressed IPv6 otherwise.
 *
 * The recorder preload imports this file under Node's type stripping, so it
 * uses only erasable TypeScript.
 */

const GOOGLE_IPV4_RANGES: readonly string[] = [
  '8.8.4.0/24',
  '8.8.8.0/24',
  '64.233.160.0/19',
  '66.102.0.0/20',
  '66.249.64.0/19',
  '72.14.192.0/18',
  '74.125.0.0/16',
  '108.177.0.0/17',
  '142.250.0.0/15',
  '172.217.0.0/16',
  '172.253.0.0/16',
  '173.194.0.0/16',
  '209.85.128.0/17',
  '216.58.192.0/19',
  '216.239.32.0/19',
];

const GOOGLE_IPV6_RANGES: readonly string[] = [
  '2001:4860::/32',
  '2404:6800::/32',
  '2607:f8b0::/32',
  '2800:3f0::/32',
  '2a00:1450::/32',
  '2c0f:fb50::/32',
];

const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_GROUPS = 8;
const HEXTET_BITS = 16;

/** A dotted quad as one unsigned 32-bit number. */
function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function inIpv4Range(address: string, range: string): boolean {
  const [base = '', bits = '0'] = range.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4Number(address) / size) === Math.floor(ipv4Number(base) / size);
}

/** Compressed IPv6 text as its eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const parse = (text: string) => (text === '' ? [] : text.split(':').map((group) => Number.parseInt(group, 16)));
  const front = parse(head);
  if (tail === undefined) return front;
  const back = parse(tail);
  return [...front, ...new Array<number>(IPV6_GROUPS - front.length - back.length).fill(0), ...back];
}

function inIpv6Range(address: string, range: string): boolean {
  const [base = '', bits = '0'] = range.split('/');
  const groups = ipv6Groups(address);
  const baseGroups = ipv6Groups(base);
  let remaining = Number(bits);
  for (let index = 0; remaining > 0; index += 1) {
    const used = Math.min(remaining, HEXTET_BITS);
    const size = 2 ** (HEXTET_BITS - used);
    if (Math.floor((groups[index] ?? 0) / size) !== Math.floor((baseGroups[index] ?? 0) / size)) return false;
    remaining -= used;
  }
  return true;
}

/** Whether `address`, in `normalizeHostname`'s spelling, is in one of Google's own ranges. */
export function isGoogleAddress(address: string): boolean {
  if (DOTTED_QUAD.test(address)) return GOOGLE_IPV4_RANGES.some((range) => inIpv4Range(address, range));
  const isIpv6 = address.includes(':');
  if (isIpv6) return GOOGLE_IPV6_RANGES.some((range) => inIpv6Range(address, range));
  return false;
}
