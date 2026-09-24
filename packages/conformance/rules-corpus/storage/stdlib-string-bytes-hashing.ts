/**
 * ─── Scenario: stdlib-string-bytes-hashing ──────────────────────────────────
 * String methods `lower()`, `upper()`, `trim()`, `replace()`, and `toUtf8()`,
 * the Bytes values `toUtf8()` and `hashing.*` return, and the hashing digests
 * themselves, in Storage rules.
 *
 * The replace cases separate a regular-expression replace from a literal one
 * (`'.'` matches every character as a pattern, one character as a literal) and
 * a replace-all from a replace-first. The replacement string follows Java
 * `Matcher` template rules: `$1` expands a numbered group and `\$` inserts a
 * dollar sign. A replacement of `$&` makes the Rules Test API answer HTTP 500
 * for the whole request, so no case pins it. Negative controls pin the
 * receiver and argument types: an int has no string methods and does not
 * hash, and an uncompilable pattern is an error.
 */
import type { StorageScenarioRecord } from './types.ts';

const ALICE_SHA256_HEX = '2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90';

function getCase(description: string, expectation: 'ALLOW' | 'DENY', path: string) {
  return {
    description,
    expectation,
    method: 'get' as const,
    path,
    auth: { uid: 'alice' },
    existingResource: {
      size: 10,
      contentType: 'application/pdf',
      metadata: { name: 'Report.PDF', ownerHash: ALICE_SHA256_HEX },
    },
    requestTime: '2025-06-15T00:00:00Z',
  };
}

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-STDLIB-STRING',
  rationale:
    'String case, trim, regular-expression replace-all, and toUtf8, plus Bytes encodings and equality and the md5/sha256/crc32/crc32c digests, with int receivers, int hash input, and an invalid pattern as negative controls.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /case/{id} {
      allow get: if 'AbC'.lower() == 'abc' && 'AbC'.upper() == 'ABC'
        && '  x y  '.trim() == 'x y';
    }
    match /metadata-case/{id} {
      allow get: if resource.metadata.name.lower() == 'report.pdf';
    }
    match /replace-all/{id} {
      allow get: if 'aXa'.replace('a', 'b') == 'bXb';
    }
    match /replace-pattern/{id} {
      allow get: if 'a.b'.replace('.', '-') == '---';
    }
    match /replace-literal/{id} {
      allow get: if 'a.b'.replace('.', '-') == 'a-b';
    }
    match /replace-class/{id} {
      allow get: if 'a1b22'.replace('[0-9]+', '#') == 'a#b#';
    }
    match /replace-group-reference/{id} {
      allow get: if 'ab'.replace('(a)', '$1$1') == 'aab';
    }
    match /replace-escaped-dollar/{id} {
      allow get: if 'ab'.replace('a', '\\\\$') == '$b';
    }
    match /replace-invalid-pattern/{id} {
      allow get: if 'abc'.replace('(', 'x') == 'abc';
    }
    match /utf8-size/{id} {
      allow get: if 'é'.toUtf8().size() == 2 && 'abc'.toUtf8().size() == 3;
    }
    match /bytes-encodings/{id} {
      allow get: if 'hi'.toUtf8().toBase64() == 'aGk='
        && 'hi'.toUtf8().toHexString() == '6869';
    }
    match /bytes-equality/{id} {
      allow get: if 'hi'.toUtf8() == 'hi'.toUtf8() && 'hi'.toUtf8() != 'ho'.toUtf8();
    }
    match /md5/{id} {
      allow get: if hashing.md5('abc').toHexString() == '900150983CD24FB0D6963F7D28E17F72';
    }
    match /sha256/{id} {
      allow get: if hashing.sha256('abc').toHexString()
        == 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
    }
    match /crc/{id} {
      allow get: if hashing.crc32('abc').toHexString() == 'C2412435'
        && hashing.crc32c('abc').toHexString() == 'B73F4B36';
    }
    match /hash-bytes-input/{id} {
      allow get: if hashing.sha256('abc'.toUtf8()) == hashing.sha256('abc');
    }
    match /owner-hash/{id} {
      allow get: if hashing.sha256(request.auth.uid).toHexString().lower()
        == resource.metadata.ownerHash;
    }
    match /int-string-method/{id} {
      allow get: if resource.size.lower() == '10';
    }
    match /hash-int/{id} {
      allow get: if hashing.md5(resource.size).size() == 16;
    }
  }
}`,
  cases: [
    getCase('lower, upper, and trim', 'ALLOW', 'case/a'),
    getCase('lower over custom metadata', 'ALLOW', 'metadata-case/a'),
    getCase('replace replaces every match', 'ALLOW', 'replace-all/a'),
    getCase('replace treats the pattern as a regular expression', 'ALLOW', 'replace-pattern/a'),
    getCase('replace does not treat the pattern as a literal', 'DENY', 'replace-literal/a'),
    getCase('replace with a character class', 'ALLOW', 'replace-class/a'),
    getCase('replace expands a numbered group reference', 'ALLOW', 'replace-group-reference/a'),
    getCase('replace inserts an escaped dollar sign literally', 'ALLOW', 'replace-escaped-dollar/a'),
    getCase('replace with an invalid pattern is an error', 'DENY', 'replace-invalid-pattern/a'),
    getCase('toUtf8 size counts UTF-8 bytes', 'ALLOW', 'utf8-size/a'),
    getCase('bytes toBase64 and toHexString', 'ALLOW', 'bytes-encodings/a'),
    getCase('bytes compare by value', 'ALLOW', 'bytes-equality/a'),
    getCase('md5 digest', 'ALLOW', 'md5/a'),
    getCase('sha256 digest', 'ALLOW', 'sha256/a'),
    getCase('crc32 and crc32c digests', 'ALLOW', 'crc/a'),
    getCase('hashing a string equals hashing its UTF-8 bytes', 'ALLOW', 'hash-bytes-input/a'),
    getCase('sha256 of the caller uid against metadata', 'ALLOW', 'owner-hash/a'),
    getCase('int receiver has no lower() method', 'DENY', 'int-string-method/a'),
    getCase('hashing an int is an error', 'DENY', 'hash-int/a'),
  ],
};
