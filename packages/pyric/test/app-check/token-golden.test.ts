/**
 * App Check tokens are byte-identical after the codec and signer moved to the
 * shared `sandbox-jwt.ts` (#1836). The goldens were captured from the
 * App Check module before the move, so any change to encoding, the key, or
 * the signature expansion fails here.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { checkAppCheckToken, mintAppCheckToken, signAppCheckToken } from '../../src/sandbox/internal/index.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const HEADER = { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' };

const GOLDEN = {
  ascii: 'eyJhbGciOiJSUzI1NiIsImtpZCI6InB5cmljLXNhbmRib3giLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxOjEyMzQ1Njc4OTAxMjp3ZWI6MGExYjJjM2Q0ZTVmNjA3MTgyOTNhNCIsImF1ZCI6WyJwcm9qZWN0cy9wIl0sImlzcyI6Imh0dHBzOi8vZmlyZWJhc2VhcHBjaGVjay5nb29nbGVhcGlzLmNvbS8xIiwiZXhwIjoxLCJpYXQiOjAsImp0aSI6ImEifQ.kgZoQCeIJ3t_ExYRUrZlenxIs2-uQKeXCgXnV3RZuLIO4BR13gYOEPapTWq_15-hFZFbpBN_ibYt4QzzNLn8Z4LdTACnlPw3N6hx14SKA_OS7f5Yh1qiaO3AJSqRlpLs0-Jh9ap3VYi3fV75VfQOiR50fijDwgu4-zisW23TFNr-JitvD9QrR7jhWZALFvBUn6Lajn4FAqpbZWmeoEtg3OTYKy1_96hZss-mHK66zXhumeSeoaRMOILbfVP6_DQ93iSLtbX9PtbCZ-XzOgFB5GCdWKBhBeYihAZai95AGBXt1tscq_iBiUrlQZVqt-R4juK7YOorEFTJGR0kOGs5EQ',
  unicode: 'eyJhbGciOiJSUzI1NiIsImtpZCI6InB5cmljLXNhbmRib3giLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxOjEyMzQ1Njc4OTAxMjp3ZWI6MGExYjJjM2Q0ZTVmNjA3MTgyOTNhNCIsImF1ZCI6WyJwcm9qZWN0cy9wcsO4amVjdC3ml6XmnKwiXSwibm90ZSI6ImNhZsOpIPCflKUiLCJleHAiOjEsImlhdCI6MCwianRpIjoiYWIifQ.cZkABzkGZbDBga4WHvjtMcKvo5wEMx9SUsW_y1FNvvAtL3p5QWnaTOgJcYP9jL8l2zSHI4pIFYVm4xyu6RFA_SYHXNJR-ROwYf6PKDrE0l6AaaPLx0jSCqCQDgp08gUVXeYyFpwLGMOuGAzTUr1UGx2cc9zp8unwsnmQluUB7sST1rlabVewz8ueeZUSQ3NILuf0gilUpC64VJyxvExCD2-o2kNz-h2bVBERFHQ0O8VZuiOft_3FKIKw5kV4y2ezUN0Wjgrz687Dt5UxC6rkS8VX4okQ5hu48KFs7-VpvxgeonpSFpRTzB1QteQANCuU7ndyxJlXr7M89pRdG4Fliw',
  empty: 'e30.e30.C2zzVxF0tps0N9BblUXSg4L-KImlthYusjbsUya23AkcPETb-3VS8ccAqubagy0RwoA4wH1tqP5ZBZUytCbxvvdnhLdkXptpxoazito734jZQgnXwGrACJzC8VMDkoNo_hkS2JFY5nghZEQFweRQJ5iZDzh8XNuaRXXZrubGmFCa1agpMFJNTipkC6M2gF5WZKQooFDo6wIzWL6xpQCOYTHw5k0BhsDUArP5uXBX9WR9MXFDZ2gb40XhuOz0xsdZNCAYYojWCWUDCvzqcHO_GOjB6YQtZrCNXExiVXFFMJxwpYT-fSmPdd1VkKemxOXYyYieXv1WTcgzw1Kg0-Y0EA',
  minted: 'eyJhbGciOiJSUzI1NiIsImtpZCI6InB5cmljLXNhbmRib3giLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxOjEyMzQ1Njc4OTAxMjp3ZWI6MGExYjJjM2Q0ZTVmNjA3MTgyOTNhNCIsImF1ZCI6WyJwcm9qZWN0cy8xMjM0NTY3ODkwMTIiLCJwcm9qZWN0cy9kZW1vLXByb2plY3QiXSwicHJvdmlkZXIiOiJweXJpYy1zYW5kYm94IiwibHUiOiJweXJpYy1zYW5kYm94IiwiaXNzIjoiaHR0cHM6Ly9maXJlYmFzZWFwcGNoZWNrLmdvb2dsZWFwaXMuY29tLzEyMzQ1Njc4OTAxMiIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwLCJqdGkiOiJCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjIn0.vojzjf9i9yN_fMsQ2GrFfB2IauLljLv2bKtoHgDFIlg5xzRLYwDvAsRcoK5O76P5vfCfnDOWsHPY97giJlsGVNwIlPR3dNiyHbdnl43ZHcs8VhRKsqmC_pB0u9HFFdZrHjBkLp8UPX1kxvh8_vg6oRFuRT8zP4ivoay55CpXfbmmmzkMoSYdExgskVXOzcyhNwryNUGrvu3B0sN4g5Qu4iX7-uOMOhYfENf4ablSuFm7gsGZKb-Ba1gqqNl17TqjFkhXzOyPn1rJfgwzmCBGgzIxzXY8wT_WYkvukbMaLLuwhdYzCIwHPG2ECVOBmXjqlFHem1Xz1-qUKqHszheU6g',
};

const realGetRandomValues = crypto.getRandomValues.bind(crypto);

afterEach(() => {
  crypto.getRandomValues = realGetRandomValues;
});

/** Fills every random buffer with 7s, so a minted token's `jti` is fixed. */
function fixRandomBytes(): void {
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array instanceof Uint8Array) array.fill(7);
    return array;
  }) as typeof crypto.getRandomValues;
}

describe('App Check tokens after the shared signer move', () => {
  it('signs ASCII claims byte for byte as before', async () => {
    const token = await signAppCheckToken(HEADER, {
      sub: APP_ID, aud: ['projects/p'], iss: 'https://firebaseappcheck.googleapis.com/1', exp: 1, iat: 0, jti: 'a',
    });
    expect(token).toBe(GOLDEN.ascii);
  });

  it('signs non-ASCII claims byte for byte as before', async () => {
    const token = await signAppCheckToken(HEADER, {
      sub: APP_ID, aud: ['projects/prøject-日本'], note: 'café 🔥', exp: 1, iat: 0, jti: 'ab',
    });
    expect(token).toBe(GOLDEN.unicode);
  });

  it('signs an empty header and claims byte for byte as before', async () => {
    expect(await signAppCheckToken({}, {})).toBe(GOLDEN.empty);
  });

  it('mints a token byte for byte as before', async () => {
    fixRandomBytes();
    const minted = await mintAppCheckToken({ appId: APP_ID, projectId: 'demo-project' }, 3600, 1_700_000_000_000);
    expect(minted.token).toBe(GOLDEN.minted);
    expect(minted.expireTimeMillis).toBe(1_700_003_600_000);
  });

  it('checks every golden token', async () => {
    for (const token of Object.values(GOLDEN)) expect((await checkAppCheckToken(token)).ok).toBe(true);
  });
});
