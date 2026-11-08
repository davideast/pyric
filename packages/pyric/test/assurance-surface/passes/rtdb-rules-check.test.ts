import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';
import { checkRtdbIndexes } from '../../../src/assurance-surface/passes/rtdb-rules-check.js';

describe('checkRtdbIndexes', () => {
  test('detects literal-child wildcard shadowing when $wildcard declares .indexOn but literal sibling omits it', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/orgs.ts': `
          import { get, orderByChild, query, ref } from 'firebase/database';
          declare const db: unknown;
          export function listAdmins(orgId: string) {
            return get(query(ref(db, 'orgs/' + orgId + '/members'), orderByChild('role')));
          }
        `,
      },
    });

    const pass = rtdbIndexPass(usage);
    const shadowedRules = {
      rules: {
        orgs: {
          $orgId: {
            members: {
              '.indexOn': ['role'],
            },
          },
          featured: {
            '.read': true,
          },
        },
      },
    };

    const diagnostics = checkRtdbIndexes(shadowedRules, pass.requirements);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'rtdb-missing-index-on',
      service: 'rtdb',
      resourceId: '(default)',
      certainty: 'static-proof',
      ruleSite: { source: '/orgs/featured/members' },
    });
    expect(diagnostics[0]?.message).toContain('featured');
  });

  test('reuses existing $wildcard variable name from database.rules.json in diagnostic ruleSite and remediation', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/orgs.ts': `
          import { get, orderByChild, query, ref } from 'firebase/database';
          declare const db: unknown;
          export function listAdmins(orgId: string) {
            return get(query(ref(db, 'orgs/' + orgId + '/members'), orderByChild('role')));
          }
        `,
      },
    });

    const pass = rtdbIndexPass(usage);
    const rulesWithTenantWildcard = {
      rules: {
        orgs: {
          $tenantId: {
            '.read': 'auth != null',
          },
        },
      },
    };

    const diagnostics = checkRtdbIndexes(rulesWithTenantWildcard, pass.requirements);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.ruleSite?.source).toBe('/orgs/$tenantId/members');
    expect(diagnostics[0]?.remediation).toContain('/orgs/$tenantId/members');
  });
});
