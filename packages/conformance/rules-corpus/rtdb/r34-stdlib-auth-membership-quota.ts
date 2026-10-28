/**
 * ─── r34-stdlib-auth-membership-quota ─────────────────────────────────────
 * The RTDB rules standard library's auth, membership and windowed-quota
 * patterns, deployed as compiled JSON. The ruleset is
 * `AUTH_MEMBERSHIP_PATHS` from
 * packages/pyric/test/rules/rtdb/stdlib/fixtures/auth-membership-rules.ts
 * compiled by `defineRtdbRules`.
 *
 * Cases with an `identity` sign in as an Auth user the capture creates for
 * it, with an email at the given domain, verified or not, through a custom
 * token carrying the given developer claims; the capture deletes those users.
 * The other signed-in cases sign in anonymously, so their tokens carry no
 * email, no custom claims and no tenant.
 *
 *   - verified, staff: `email_verified` and an email domain.
 *   - admin, beta: custom-claim roles and a boolean claim, compared without
 *     type conversion.
 *   - acme: a tenant check, which a token without a tenant fails. A tenant
 *     sign-in is not captured.
 *   - orgs: a role stored in the database, read two levels up.
 *   - rooms: a member list read from the stored data, and members who add
 *     or remove only themselves.
 *   - posts and quota: at most 2 posts per 60-second window per user, the
 *     quota moved in the same write as the post.
 *
 * Covers: auth.token claims from an Auth account and a custom token, and the
 * standard library's compiled output for them.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'rules that read who the writer is (a verified email, an email domain, custom-claim roles, a tenant, a role or membership stored in the database) and windowed quotas must deploy and decide as the standard library documents.',
  provenance:
    'Authored with the RTDB rules standard library. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r34-stdlib-auth-membership-quota.json.',
  rules: JSON.stringify({
    "acme": {
      ".write": "auth != null && auth.token.firebase.tenant == 'acme'",
      ".validate": "newData.isString()"
    },
    "admin": {
      ".write": "auth != null && (auth.token.role == 'admin' || auth.token.role == 'editor')",
      ".validate": "newData.isString()"
    },
    "beta": {
      ".write": "auth != null && auth.token.beta == true",
      ".validate": "newData.isString()"
    },
    "staff": {
      ".write": "auth != null && auth.token.email_verified == true && auth.token.email.endsWith('@example.com')",
      ".validate": "newData.isString()"
    },
    "verified": {
      ".write": "auth != null && auth.token.email_verified == true",
      ".validate": "newData.isString()"
    },
    "posts": {
      "$postId": {
        ".write": "auth != null && !data.exists() && newData.exists()",
        ".validate": "newData.parent().parent().child('quota').child(auth.uid).child('count').val() != data.parent().parent().child('quota').child(auth.uid).child('count').val() || newData.parent().parent().child('quota').child(auth.uid).child('windowStart').val() != data.parent().parent().child('quota').child(auth.uid).child('windowStart').val()"
      }
    },
    "quota": {
      "$uid": {
        ".write": "auth.uid == $uid && newData.exists()",
        ".validate": "newData.child('count').isNumber() && newData.child('count').val() <= 2 && ((newData.child('windowStart').val() == now && newData.child('count').val() == 1 && (!data.exists() || (data.child('windowStart').isNumber() && now >= data.child('windowStart').val() + 60000))) || (data.child('windowStart').isNumber() && data.child('count').isNumber() && newData.child('windowStart').val() == data.child('windowStart').val() && now < data.child('windowStart').val() + 60000 && newData.child('count').val() == data.child('count').val() + 1))"
      }
    },
    "orgs": {
      "$orgId": {
        "docs": {
          "$docId": {
            ".write": "auth != null && data.parent().parent().child('roles').child(auth.uid).val() == 'editor'",
            ".validate": "newData.isString()"
          }
        }
      }
    },
    "rooms": {
      "$roomId": {
        "members": {
          "$uid": {
            ".write": "auth != null && auth.uid == $uid && (newData.val() == true || !newData.exists())",
            ".validate": "newData.val() == true"
          }
        },
        "messages": {
          "$msgId": {
            ".read": "auth != null && data.parent().parent().child('members').child(auth.uid).val() == true",
            ".write": "auth != null && data.parent().parent().child('members').child(auth.uid).val() == true && !data.exists() && newData.exists()",
            ".validate": "newData.isString()"
          }
        }
      }
    }
  }),
  cases: [
    {"description":"a verified email writes","expectation":"ALLOW","operation":"write","opPath":"/verified","authPresent":true,"identity":{"emailDomain":"example.com","emailVerified":true},"newData":"x"},
    {"description":"an unverified email writes","expectation":"DENY","operation":"write","opPath":"/verified","authPresent":true,"identity":{"emailDomain":"example.com","emailVerified":false},"newData":"x"},
    {"description":"an anonymous user writes where a verified email is required","expectation":"DENY","operation":"write","opPath":"/verified","authPresent":true,"newData":"x"},
    {"description":"a verified email at the staff domain writes","expectation":"ALLOW","operation":"write","opPath":"/staff","authPresent":true,"identity":{"emailDomain":"example.com","emailVerified":true},"newData":"x"},
    {"description":"a verified email at another domain writes","expectation":"DENY","operation":"write","opPath":"/staff","authPresent":true,"identity":{"emailDomain":"example.org","emailVerified":true},"newData":"x"},
    {"description":"an unverified email at the staff domain writes","expectation":"DENY","operation":"write","opPath":"/staff","authPresent":true,"identity":{"emailDomain":"example.com","emailVerified":false},"newData":"x"},
    {"description":"an anonymous user writes the staff area","expectation":"DENY","operation":"write","opPath":"/staff","authPresent":true,"newData":"x"},
    {"description":"an admin role claim writes","expectation":"ALLOW","operation":"write","opPath":"/admin","authPresent":true,"identity":{"claims":{"role":"admin"}},"newData":"x"},
    {"description":"an editor role claim writes","expectation":"ALLOW","operation":"write","opPath":"/admin","authPresent":true,"identity":{"claims":{"role":"editor"}},"newData":"x"},
    {"description":"a viewer role claim writes","expectation":"DENY","operation":"write","opPath":"/admin","authPresent":true,"identity":{"claims":{"role":"viewer"}},"newData":"x"},
    {"description":"a user without a role claim writes","expectation":"DENY","operation":"write","opPath":"/admin","authPresent":true,"newData":"x"},
    {"description":"a beta claim of true writes","expectation":"ALLOW","operation":"write","opPath":"/beta","authPresent":true,"identity":{"claims":{"beta":true}},"newData":"x"},
    {"description":"a beta claim of the string true writes","expectation":"DENY","operation":"write","opPath":"/beta","authPresent":true,"identity":{"claims":{"beta":"true"}},"newData":"x"},
    {"description":"a user without a tenant writes the tenant area","expectation":"DENY","operation":"write","opPath":"/acme","authPresent":true,"newData":"x"},
    {"description":"an editor in the org database writes","expectation":"ALLOW","operation":"write","opPath":"/orgs/o1/docs/d1","authPresent":true,"newData":"x","seed":{"/orgs/o1/roles/<UID>":"editor"}},
    {"description":"a viewer in the org database writes","expectation":"DENY","operation":"write","opPath":"/orgs/o1/docs/d1","authPresent":true,"newData":"x","seed":{"/orgs/o1/roles/<UID>":"viewer"}},
    {"description":"a user with no role in the org writes","expectation":"DENY","operation":"write","opPath":"/orgs/o1/docs/d1","authPresent":true,"newData":"x","seed":{"/orgs/o1/roles/other-user":"editor"}},
    {"description":"a member posts","expectation":"ALLOW","operation":"write","opPath":"/rooms/r1/messages/m1","authPresent":true,"newData":"hi","seed":{"/rooms/r1/members":{"<UID>":true,"other-user":true,"left-user":false}}},
    {"description":"a user stored as false posts","expectation":"DENY","operation":"write","opPath":"/rooms/r1/messages/m1","authPresent":true,"newData":"hi","seed":{"/rooms/r1/members":{"<UID>":false}}},
    {"description":"a user not in the list posts","expectation":"DENY","operation":"write","opPath":"/rooms/r1/messages/m1","authPresent":true,"newData":"hi","seed":{"/rooms/r1/members":{"other-user":true}}},
    {"description":"a member reads the messages","expectation":"ALLOW","operation":"read","opPath":"/rooms/r1/messages/m1","authPresent":true,"seed":{"/rooms/r1/members":{"<UID>":true,"other-user":true,"left-user":false}}},
    {"description":"a user not in the list reads the messages","expectation":"DENY","operation":"read","opPath":"/rooms/r1/messages/m1","authPresent":true,"seed":{"/rooms/r1/members":{"other-user":true}}},
    {"description":"a user joins and posts in one write","expectation":"DENY","operation":"update","opPath":"/rooms/r1","authPresent":true,"newData":{"members/<UID>":true,"messages/m2":"hi"},"seed":{"/rooms/r1/members":{"other-user":true}}},
    {"description":"a user adds themself","expectation":"ALLOW","operation":"write","opPath":"/rooms/r1/members/<UID>","authPresent":true,"newData":true},
    {"description":"a user removes themself","expectation":"ALLOW","operation":"write","opPath":"/rooms/r1/members/<UID>","authPresent":true,"newData":null,"seed":{"/rooms/r1/members":{"<UID>":true,"other-user":true,"left-user":false}}},
    {"description":"a user adds someone else","expectation":"DENY","operation":"write","opPath":"/rooms/r1/members/other-user","authPresent":true,"newData":true},
    {"description":"a user adds themself with a string","expectation":"DENY","operation":"write","opPath":"/rooms/r1/members/<UID>","authPresent":true,"newData":"yes"},
    {"description":"a first post opens the window","expectation":"ALLOW","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p1":"x","quota/<UID>":{"windowStart":{".sv":"timestamp"},"count":1}}},
    {"description":"a second post inside the window","expectation":"ALLOW","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p2":"x","quota/<UID>/count":2},"seed":{"/quota/<UID>":{"windowStart":99999999999999,"count":1}}},
    {"description":"a third post inside the window","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p3":"x","quota/<UID>/count":3},"seed":{"/quota/<UID>":{"windowStart":99999999999999,"count":2}}},
    {"description":"a post after the window opens a new one","expectation":"ALLOW","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p4":"x","quota/<UID>":{"windowStart":{".sv":"timestamp"},"count":1}},"seed":{"/quota/<UID>":{"windowStart":1000000000000,"count":2}}},
    {"description":"a new window opened before the old one ends","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p5":"x","quota/<UID>":{"windowStart":{".sv":"timestamp"},"count":1}},"seed":{"/quota/<UID>":{"windowStart":99999999999999,"count":2}}},
    {"description":"a window opened with a client clock time","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p6":"x","quota/<UID>":{"windowStart":1000000000000,"count":1}}},
    {"description":"a post that leaves the quota unchanged","expectation":"DENY","operation":"write","opPath":"/posts/p8","authPresent":true,"newData":"x","seed":{"/quota/<UID>":{"windowStart":99999999999999,"count":1}}},
    {"description":"a post counted on another user quota","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p9":"x","quota/other-user":{"windowStart":{".sv":"timestamp"},"count":1}}},
    {"description":"a user deletes their quota","expectation":"DENY","operation":"write","opPath":"/quota/<UID>","authPresent":true,"newData":null,"seed":{"/quota/<UID>":{"windowStart":99999999999999,"count":2}}},
  ],
};
