/**
 * ─── r28-stdlib-presence-timing ───────────────────────────────────────────
 * The RTDB rules standard library's presence, timing and collections
 * patterns, deployed as compiled JSON. The ruleset is
 * `PRESENCE_TIMING_PATHS` from
 * packages/pyric/test/rules/rtdb/stdlib/fixtures/presence-timing-rules.ts
 * compiled by `defineRtdbRules`.
 *
 *   - status and online: a presence node only its owner writes, as
 *     `{ state, lastChanged }` with the server timestamp, or as a boolean.
 *   - posts and lastPost: a per-user rate limit. A post must be written in
 *     the same multi-path update as the writer's stamp, set to the server
 *     timestamp, and the stamp moves only once 60 seconds have passed.
 *   - events: a time no later than the server clock, and a creation time
 *     that must be the server timestamp.
 *   - tables: slots '0' to '3' and a fixed list of flag keys.
 *
 * A write of `{ ".sv": "timestamp" }` is the client's serverTimestamp();
 * production replaces it with `now` before it evaluates the rules, so
 * `newData.val() == now` holds for it and not for a client clock time.
 * Stored times far in the past and far in the future decide each cooldown
 * case whatever the clock reads.
 *
 * Covers: the standard library's compiled output for set, multi-path update
 * and delete with server timestamps.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'presence, rate limits and bounded collections from the standard library must deploy and decide as documented, including server timestamps written in the same multi-path update as the data they stamp.',
  provenance:
    'Authored with the RTDB rules standard library. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r28-stdlib-presence-timing.json.',
  rules: JSON.stringify({
    "events": {
      "$id": {
        ".write": "auth != null",
        "at": {
          ".validate": "newData.isNumber() && newData.val() <= now"
        },
        "createdAt": {
          ".validate": "newData.val() == now"
        }
      }
    },
    "lastPost": {
      "$uid": {
        ".write": "auth.uid == $uid",
        ".validate": "newData.val() == now && (!data.exists() || now > data.val() + 60000)"
      }
    },
    "online": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth != null && auth.uid == $uid",
        ".validate": "newData.isBoolean()"
      }
    },
    "posts": {
      "$postId": {
        ".read": "auth != null",
        ".write": "auth != null",
        ".validate": "newData.parent().parent().child('lastPost').child(auth.uid).val() == now"
      }
    },
    "status": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth != null && auth.uid == $uid",
        ".validate": "newData.hasChildren(['state', 'lastChanged'])",
        "$other": {
          ".validate": false
        },
        "lastChanged": {
          ".validate": "newData.val() == now"
        },
        "state": {
          ".validate": "newData.val() == 'online' || newData.val() == 'offline'"
        }
      }
    },
    "tables": {
      "$tableId": {
        ".write": "auth != null",
        "flags": {
          "$flag": {
            ".validate": "$flag == 'red' || $flag == 'blue'"
          }
        },
        "seats": {
          "$slot": {
            ".validate": "$slot == '0' || $slot == '1' || $slot == '2' || $slot == '3'"
          }
        }
      }
    }
  }),
  cases: [
    {"description":"a user marks themself online with the server time","expectation":"ALLOW","operation":"write","opPath":"/status/<UID>","authPresent":true,"newData":{"state":"online","lastChanged":{".sv":"timestamp"}}},
    {"description":"a user writes presence for someone else","expectation":"DENY","operation":"write","opPath":"/status/other-user","authPresent":true,"newData":{"state":"online","lastChanged":{".sv":"timestamp"}}},
    {"description":"a presence with a client clock time","expectation":"DENY","operation":"write","opPath":"/status/<UID>","authPresent":true,"newData":{"state":"online","lastChanged":1000000000000}},
    {"description":"a presence with an unknown state","expectation":"DENY","operation":"write","opPath":"/status/<UID>","authPresent":true,"newData":{"state":"away","lastChanged":{".sv":"timestamp"}}},
    {"description":"a presence with an extra child","expectation":"DENY","operation":"write","opPath":"/status/<UID>","authPresent":true,"newData":{"state":"online","lastChanged":{".sv":"timestamp"},"device":"x"}},
    {"description":"a user removes their presence","expectation":"ALLOW","operation":"write","opPath":"/status/<UID>","authPresent":true,"newData":null,"seed":{"/status/<UID>":{"state":"online","lastChanged":1000000000000}}},
    {"description":"a signed-out presence write","expectation":"DENY","operation":"write","opPath":"/status/other-user","authPresent":false,"newData":{"state":"online","lastChanged":{".sv":"timestamp"}}},
    {"description":"a user sets their online flag","expectation":"ALLOW","operation":"write","opPath":"/online/<UID>","authPresent":true,"newData":true},
    {"description":"a flag written as a string","expectation":"DENY","operation":"write","opPath":"/online/<UID>","authPresent":true,"newData":"yes"},
    {"description":"a user sets the online flag of someone else","expectation":"DENY","operation":"write","opPath":"/online/other-user","authPresent":true,"newData":true},
    {"description":"a first post with its stamp in the same write","expectation":"ALLOW","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p1":"hello","lastPost/<UID>":{".sv":"timestamp"}}},
    {"description":"a post once the cooldown has passed","expectation":"ALLOW","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p2":"hello","lastPost/<UID>":{".sv":"timestamp"}},"seed":{"/lastPost/<UID>":1000000000000}},
    {"description":"a post inside the cooldown","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p3":"hello","lastPost/<UID>":{".sv":"timestamp"}},"seed":{"/lastPost/<UID>":99999999999999}},
    {"description":"a post without a stamp","expectation":"DENY","operation":"write","opPath":"/posts/p4","authPresent":true,"newData":"hello"},
    {"description":"a post stamped with a client clock time","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p5":"hello","lastPost/<UID>":1000000000000}},
    {"description":"a post stamped under another user","expectation":"DENY","operation":"update","opPath":"/","authPresent":true,"newData":{"posts/p6":"hello","lastPost/other-user":{".sv":"timestamp"}}},
    {"description":"an event time in the past","expectation":"ALLOW","operation":"write","opPath":"/events/e1/at","authPresent":true,"newData":1000000000000},
    {"description":"an event time in the future","expectation":"DENY","operation":"write","opPath":"/events/e1/at","authPresent":true,"newData":99999999999999},
    {"description":"a creation time from the server","expectation":"ALLOW","operation":"write","opPath":"/events/e1/createdAt","authPresent":true,"newData":{".sv":"timestamp"}},
    {"description":"a creation time from the client","expectation":"DENY","operation":"write","opPath":"/events/e1/createdAt","authPresent":true,"newData":1000000000000},
    {"description":"a seat in the last slot","expectation":"ALLOW","operation":"write","opPath":"/tables/t1/seats/3","authPresent":true,"newData":"alice"},
    {"description":"a seat past the last slot","expectation":"DENY","operation":"write","opPath":"/tables/t1/seats/4","authPresent":true,"newData":"alice"},
    {"description":"a list of four seats","expectation":"ALLOW","operation":"write","opPath":"/tables/t1/seats","authPresent":true,"newData":["a","b","c","d"]},
    {"description":"a list of five seats","expectation":"DENY","operation":"write","opPath":"/tables/t1/seats","authPresent":true,"newData":["a","b","c","d","e"]},
    {"description":"a listed flag","expectation":"ALLOW","operation":"write","opPath":"/tables/t1/flags/red","authPresent":true,"newData":true},
    {"description":"a flag that is not listed","expectation":"DENY","operation":"write","opPath":"/tables/t1/flags/green","authPresent":true,"newData":true},
  ],
};
