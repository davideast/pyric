/**
 * ─── r27-stdlib-core-patterns ─────────────────────────────────────────────
 * The RTDB rules standard library's main patterns, deployed as compiled JSON.
 * The ruleset is `CORE_PATTERN_PATHS` from
 * packages/pyric/test/rules/rtdb/stdlib/fixtures/match-rules.ts compiled by
 * `defineRtdbRules`, plus probes under `probes` that compute with
 * `data.val()` where nothing is stored: `newData.val() == data.val() + 1`,
 * `data.val() + 1 != 1`, and `+` on either side, `-`, `*`, `+` with a
 * string, unary `-` and `<`, each followed by `|| true`. Production denies
 * every one, so an operator with a null operand is an evaluation error that
 * fails the whole rule, `|| true` included. Every standard library builder
 * that computes with a stored value, the counters and `turns.turnAdvanced`,
 * checks first that the value exists or is a number.
 *
 * `probes/stamp` requires `newData.val() == now`, written once as
 * `{ ".sv": "timestamp" }` and once as a client clock time.
 *
 * The match `.write` is 4,840 characters, and production deployed it.
 *
 *   - matches: lobby create, join, cancel and rematch; turns and the move
 *     count; resignation, win and draw; a closed match shape.
 *   - tables: a three-seat list, the seat on turn and the next turn.
 *   - boards: `turnAdvanced` before `isSeatTurn` on a board with no
 *     stored turn, so the create reaches the stored-turn check.
 *   - notes: ownership through a uid field and an immutable field.
 *   - players: string length, number range, a regular expression, required
 *     fields and a closed shape.
 *   - stats and scores: step, range and improvement counters, and a
 *     two-sided score that changes one side at a time.
 *
 * The signed-in user is the corpus uid; the other players are fixed uids
 * that never sign in. packages/pyric/test/rules/rtdb/stdlib/corpus-lock.test.ts
 * fails when the builders compile to anything other than this ruleset, and
 * runs every case through simulate and the sandbox.
 *
 * Covers: the standard library's compiled output for set, update and delete.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: "rtdb#71",
  rationale:
    'the standard library builders must compile to rules production deploys and decides the way the builders document, for sets, updates and deletes of the patterns realtime games use.',
  provenance:
    'Authored with the RTDB rules standard library. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r27-stdlib-core-patterns.json.',
  rules: JSON.stringify({
    "boards": {
      "$boardId": {
        ".write": "((data.child('turn').isNumber() && newData.child('turn').val() == (data.child('turn').val() + 1) % 3 && newData.child('players/0').val() == data.child('players/0').val() && newData.child('players/1').val() == data.child('players/1').val() && newData.child('players/2').val() == data.child('players/2').val()) && (auth != null && ((data.child('turn').val() == 0 && data.child('players/0').val() == auth.uid) || (data.child('turn').val() == 1 && data.child('players/1').val() == auth.uid) || (data.child('turn').val() == 2 && data.child('players/2').val() == auth.uid)))) || ((auth != null) && (!data.exists() && newData.exists()))"
      }
    },
    "matches": {
      "$matchId": {
        ".read": "auth != null",
        ".write": "((auth != null && !data.exists() && newData.child('host').val() == auth.uid && newData.child('guest').val() == '' && newData.child('status').val() == 'waiting') && (!(newData.child(\"rematchOf\").exists()))) || (auth != null && !data.exists() && newData.child('host').val() == auth.uid && newData.child('guest').val() == '' && newData.child('status').val() == 'waiting' && newData.child('rematchOf').isString() && (data.parent().child(newData.child('rematchOf').val()).child('status').val() == 'won' || data.parent().child(newData.child('rematchOf').val()).child('status').val() == 'draw' || data.parent().child(newData.child('rematchOf').val()).child('status').val() == 'resigned') && (data.parent().child(newData.child('rematchOf').val()).child('host').val() == auth.uid || data.parent().child(newData.child('rematchOf').val()).child('guest').val() == auth.uid)) || (auth != null && data.child('status').val() == 'waiting' && data.child('guest').val() == '' && newData.child('guest').val() == auth.uid && auth.uid != data.child('host').val() && newData.child('status').val() == 'playing' && newData.child('host').val() == data.child('host').val() && newData.child('currentTurn').val() == data.child('currentTurn').val() && newData.child('winner').val() == data.child('winner').val() && newData.child('moveCount').val() == data.child('moveCount').val() && newData.child('rematchOf').val() == data.child('rematchOf').val()) || (auth != null && !newData.exists() && data.child('status').val() == 'waiting' && data.child('host').val() == auth.uid) || (auth != null && ((data.child('host').val() == auth.uid && newData.child('winner').val() == 'guest') || (data.child('guest').val() == auth.uid && newData.child('winner').val() == 'host')) && data.child('status').val() == 'playing' && newData.child('status').val() == 'resigned' && newData.child('host').val() == data.child('host').val() && newData.child('guest').val() == data.child('guest').val() && newData.child('currentTurn').val() == data.child('currentTurn').val() && newData.child('moveCount').val() == data.child('moveCount').val() && newData.child('rematchOf').val() == data.child('rematchOf').val()) || ((auth != null && ((data.child('currentTurn').val() == 'host' && data.child('host').val() == auth.uid) || (data.child('currentTurn').val() == 'guest' && data.child('guest').val() == auth.uid))) && (data.child('status').val() == 'playing' && newData.child('status').val() == 'won' && newData.child('winner').val() == 'host' && newData.child('host').val() == data.child('host').val() && newData.child('guest').val() == data.child('guest').val() && newData.child('currentTurn').val() == data.child('currentTurn').val() && newData.child('moveCount').val() == data.child('moveCount').val() && newData.child('rematchOf').val() == data.child('rematchOf').val())) || ((auth != null && ((data.child('currentTurn').val() == 'host' && data.child('host').val() == auth.uid) || (data.child('currentTurn').val() == 'guest' && data.child('guest').val() == auth.uid))) && (data.child('status').val() == 'playing' && newData.child('status').val() == 'won' && newData.child('winner').val() == 'guest' && newData.child('host').val() == data.child('host').val() && newData.child('guest').val() == data.child('guest').val() && newData.child('currentTurn').val() == data.child('currentTurn').val() && newData.child('moveCount').val() == data.child('moveCount').val() && newData.child('rematchOf').val() == data.child('rematchOf').val())) || ((auth != null && ((data.child('currentTurn').val() == 'host' && data.child('host').val() == auth.uid) || (data.child('currentTurn').val() == 'guest' && data.child('guest').val() == auth.uid))) && (data.child('status').val() == 'playing' && newData.child('status').val() == 'draw' && newData.child('winner').val() == '' && newData.child('host').val() == data.child('host').val() && newData.child('guest').val() == data.child('guest').val() && newData.child('currentTurn').val() == data.child('currentTurn').val() && newData.child('moveCount').val() == data.child('moveCount').val() && newData.child('rematchOf').val() == data.child('rematchOf').val())) || ((auth != null && ((data.child('currentTurn').val() == 'host' && data.child('host').val() == auth.uid) || (data.child('currentTurn').val() == 'guest' && data.child('guest').val() == auth.uid))) && ((data.child('currentTurn').val() == 'host' && newData.child('currentTurn').val() == 'guest') || (data.child('currentTurn').val() == 'guest' && newData.child('currentTurn').val() == 'host')) && (newData.child('host').val() == data.child('host').val() && newData.child('guest').val() == data.child('guest').val() && newData.child('status').val() == data.child('status').val() && newData.child('winner').val() == data.child('winner').val() && newData.child('rematchOf').val() == data.child('rematchOf').val()))",
        ".validate": "newData.hasChildren(['host', 'guest', 'status'])",
        "$other": {
          ".validate": false
        },
        "currentTurn": {
          ".validate": "newData.val() == 'host' || newData.val() == 'guest'"
        },
        "guest": {
          ".validate": "newData.isString()"
        },
        "host": {
          ".validate": "newData.isString()"
        },
        "moveCount": {
          ".validate": "(!data.exists() && newData.val() == 0) || (data.exists() && newData.val() == data.val() + 1)"
        },
        "rematchOf": {
          ".validate": "newData.isString()"
        },
        "status": {
          ".validate": "newData.val() == 'waiting' || newData.val() == 'playing' || newData.val() == 'won' || newData.val() == 'draw' || newData.val() == 'resigned'"
        },
        "winner": {
          ".validate": "newData.val() == '' || newData.val() == 'host' || newData.val() == 'guest'"
        }
      }
    },
    "notes": {
      "$noteId": {
        ".read": "auth != null",
        ".write": "auth != null && ((!data.exists() && newData.child('owner').val() == auth.uid) || (data.child('owner').val() == auth.uid && (!newData.exists() || newData.child('owner').val() == auth.uid)))",
        ".validate": "!data.exists() || newData.child('createdAt').val() == data.child('createdAt').val()"
      }
    },
    "players": {
      "$uid": {
        ".read": "auth != null",
        ".write": "(auth != null) && (auth.uid == $uid)",
        ".validate": "newData.hasChildren(['name', 'level'])",
        "$other": {
          ".validate": false
        },
        "handle": {
          ".validate": "newData.isString() && newData.val().matches(/^[a-z0-9_]+$/)"
        },
        "level": {
          ".validate": "newData.isNumber() && newData.val() >= 1 && newData.val() <= 10"
        },
        "name": {
          ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 12"
        }
      }
    },
    "scores": {
      "$id": {
        ".write": "auth != null",
        ".validate": "(!data.exists() && newData.child('host').val() == 0 && newData.child('guest').val() == 0) || (data.child('host').exists() && newData.child('host').val() == data.child('host').val() + 1 && newData.child('guest').val() == data.child('guest').val()) || (data.child('guest').exists() && newData.child('guest').val() == data.child('guest').val() + 1 && newData.child('host').val() == data.child('host').val())"
      }
    },
    "stats": {
      "$id": {
        ".write": "auth != null",
        "best": {
          ".validate": "newData.isNumber() && (!data.exists() || newData.val() > data.val())"
        },
        "likes": {
          ".validate": "newData.isNumber() && data.exists() && newData.val() - data.val() >= -1 && newData.val() - data.val() <= 1"
        },
        "moves": {
          ".validate": "data.exists() && newData.val() == data.val() + 1"
        }
      }
    },
    "tables": {
      "$tableId": {
        ".read": "auth != null",
        ".write": "(auth != null && ((data.child('turn').val() == 0 && data.child('players/0').val() == auth.uid) || (data.child('turn').val() == 1 && data.child('players/1').val() == auth.uid) || (data.child('turn').val() == 2 && data.child('players/2').val() == auth.uid))) && (data.child('turn').isNumber() && newData.child('turn').val() == (data.child('turn').val() + 1) % 3 && newData.child('players/0').val() == data.child('players/0').val() && newData.child('players/1').val() == data.child('players/1').val() && newData.child('players/2').val() == data.child('players/2').val())"
      }
    },
    "probes": {
      "stamp": {
        ".write": "auth != null",
        ".validate": "newData.val() == now"
      },
      "nullstep": {
        ".write": "auth != null",
        ".validate": "newData.val() == data.val() + 1"
      },
      "nullsumor": {
        ".write": "auth != null",
        ".validate": "data.val() + 1 == 1 || true"
      },
      "nullsumne": {
        ".write": "auth != null",
        ".validate": "data.val() + 1 != 1"
      },
      "nullright": {
        ".write": "auth != null",
        ".validate": "1 + data.val() == 1 || true"
      },
      "nullsub": {
        ".write": "auth != null",
        ".validate": "data.val() - 1 == -1 || true"
      },
      "nullmul": {
        ".write": "auth != null",
        ".validate": "data.val() * 2 == 0 || true"
      },
      "nullconcat": {
        ".write": "auth != null",
        ".validate": "data.val() + 'a' == 'nulla' || true"
      },
      "nullneg": {
        ".write": "auth != null",
        ".validate": "-data.val() == 0 || true"
      },
      "nullcompare": {
        ".write": "auth != null",
        ".validate": "data.val() < 1 || true"
      }
    }
  }),
  cases: [
    {"description":"the host creates a waiting match","expectation":"ALLOW","operation":"write","opPath":"/matches/c1","authPresent":true,"newData":{"host":"<UID>","guest":"","status":"waiting","moveCount":0}},
    {"description":"a create naming another user as host","expectation":"DENY","operation":"write","opPath":"/matches/c2","authPresent":true,"newData":{"host":"player-two","guest":"","status":"waiting"}},
    {"description":"a create with a field outside the shape","expectation":"DENY","operation":"write","opPath":"/matches/c3","authPresent":true,"newData":{"host":"<UID>","guest":"","status":"waiting","cheat":true}},
    {"description":"a create that starts the move count past 0","expectation":"DENY","operation":"write","opPath":"/matches/c4","authPresent":true,"newData":{"host":"<UID>","guest":"","status":"waiting","moveCount":1}},
    {"description":"a signed-out create","expectation":"DENY","operation":"write","opPath":"/matches/c5","authPresent":false,"newData":{"host":"player-two","guest":"","status":"waiting"}},
    {"description":"a user joins the open seat","expectation":"ALLOW","operation":"update","opPath":"/matches/j1","authPresent":true,"newData":{"guest":"<UID>","status":"playing"},"seed":{"/matches/j1":{"host":"player-two","guest":"","status":"waiting"}}},
    {"description":"a join that also sets the turn","expectation":"DENY","operation":"update","opPath":"/matches/j2","authPresent":true,"newData":{"guest":"<UID>","status":"playing","currentTurn":"guest"},"seed":{"/matches/j2":{"host":"player-two","guest":"","status":"waiting"}}},
    {"description":"the host joins their own match","expectation":"DENY","operation":"update","opPath":"/matches/j3","authPresent":true,"newData":{"guest":"<UID>","status":"playing"},"seed":{"/matches/j3":{"host":"<UID>","guest":"","status":"waiting"}}},
    {"description":"the host deletes the waiting match","expectation":"ALLOW","operation":"write","opPath":"/matches/x1","authPresent":true,"newData":null,"seed":{"/matches/x1":{"host":"<UID>","guest":"","status":"waiting"}}},
    {"description":"the host deletes a match in play","expectation":"DENY","operation":"write","opPath":"/matches/x2","authPresent":true,"newData":null,"seed":{"/matches/x2":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"a player of a finished match opens a rematch","expectation":"ALLOW","operation":"write","opPath":"/matches/r1","authPresent":true,"newData":{"host":"<UID>","guest":"","status":"waiting","rematchOf":"f1"},"seed":{"/matches/f1":{"host":"player-two","guest":"<UID>","status":"won","currentTurn":"host","winner":"host","moveCount":9}}},
    {"description":"a rematch of a match still in play","expectation":"DENY","operation":"write","opPath":"/matches/r2","authPresent":true,"newData":{"host":"<UID>","guest":"","status":"waiting","rematchOf":"f2"},"seed":{"/matches/f2":{"host":"player-two","guest":"<UID>","status":"playing","currentTurn":"host","winner":"","moveCount":2}}},
    {"description":"a rematch of a match that does not exist","expectation":"DENY","operation":"write","opPath":"/matches/r3","authPresent":true,"newData":{"host":"<UID>","guest":"","status":"waiting","rematchOf":"missing"}},
    {"description":"the host moves on the host turn","expectation":"ALLOW","operation":"update","opPath":"/matches/m1","authPresent":true,"newData":{"currentTurn":"guest","moveCount":4},"seed":{"/matches/m1":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"the host moves on the guest turn","expectation":"DENY","operation":"update","opPath":"/matches/m2","authPresent":true,"newData":{"currentTurn":"host","moveCount":4},"seed":{"/matches/m2":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"guest","winner":"","moveCount":3}}},
    {"description":"a move that counts two moves","expectation":"DENY","operation":"update","opPath":"/matches/m3","authPresent":true,"newData":{"currentTurn":"guest","moveCount":5},"seed":{"/matches/m3":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"a move that also sets the winner","expectation":"DENY","operation":"update","opPath":"/matches/m4","authPresent":true,"newData":{"currentTurn":"guest","moveCount":4,"winner":"host"},"seed":{"/matches/m4":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"the host resigns and the guest wins","expectation":"ALLOW","operation":"update","opPath":"/matches/e1","authPresent":true,"newData":{"status":"resigned","winner":"guest"},"seed":{"/matches/e1":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"guest","winner":"","moveCount":3}}},
    {"description":"the host resigns naming themself the winner","expectation":"DENY","operation":"update","opPath":"/matches/e2","authPresent":true,"newData":{"status":"resigned","winner":"host"},"seed":{"/matches/e2":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"the player on turn records a win","expectation":"ALLOW","operation":"update","opPath":"/matches/e3","authPresent":true,"newData":{"status":"won","winner":"host"},"seed":{"/matches/e3":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"the player on turn records a draw","expectation":"ALLOW","operation":"update","opPath":"/matches/e4","authPresent":true,"newData":{"status":"draw","winner":""},"seed":{"/matches/e4":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"a draw that names a winner","expectation":"DENY","operation":"update","opPath":"/matches/e5","authPresent":true,"newData":{"status":"draw","winner":"host"},"seed":{"/matches/e5":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"a signed-in user reads a match","expectation":"ALLOW","operation":"read","opPath":"/matches/m1","authPresent":true,"seed":{"/matches/m1":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"a signed-out user reads a match","expectation":"DENY","operation":"read","opPath":"/matches/m1","authPresent":false,"seed":{"/matches/m1":{"host":"<UID>","guest":"player-two","status":"playing","currentTurn":"host","winner":"","moveCount":3}}},
    {"description":"the last seat moves and the turn wraps to seat 0","expectation":"ALLOW","operation":"update","opPath":"/tables/t1","authPresent":true,"newData":{"turn":0},"seed":{"/tables/t1":{"players":{"0":"seat-zero","1":"seat-one","2":"<UID>"},"turn":2}}},
    {"description":"a move that skips a seat","expectation":"DENY","operation":"update","opPath":"/tables/t2","authPresent":true,"newData":{"turn":1},"seed":{"/tables/t2":{"players":{"0":"seat-zero","1":"seat-one","2":"<UID>"},"turn":2}}},
    {"description":"a seat moves out of turn","expectation":"DENY","operation":"update","opPath":"/tables/t3","authPresent":true,"newData":{"turn":1},"seed":{"/tables/t3":{"players":{"0":"seat-zero","1":"seat-one","2":"<UID>"},"turn":0}}},
    {"description":"a user creates a note they own","expectation":"ALLOW","operation":"write","opPath":"/notes/n1","authPresent":true,"newData":{"owner":"<UID>","createdAt":1,"title":"a"}},
    {"description":"a user creates a note owned by someone else","expectation":"DENY","operation":"write","opPath":"/notes/n2","authPresent":true,"newData":{"owner":"player-two","createdAt":1}},
    {"description":"the owner hands the note to another user","expectation":"DENY","operation":"update","opPath":"/notes/n3","authPresent":true,"newData":{"owner":"player-two"},"seed":{"/notes/n3":{"owner":"<UID>","createdAt":1}}},
    {"description":"the owner deletes the note","expectation":"ALLOW","operation":"write","opPath":"/notes/n4","authPresent":true,"newData":null,"seed":{"/notes/n4":{"owner":"<UID>","createdAt":1}}},
    {"description":"another user edits the note","expectation":"DENY","operation":"update","opPath":"/notes/n5","authPresent":true,"newData":{"title":"b"},"seed":{"/notes/n5":{"owner":"player-two","createdAt":1}}},
    {"description":"the owner changes the immutable createdAt","expectation":"DENY","operation":"update","opPath":"/notes/n6","authPresent":true,"newData":{"createdAt":2},"seed":{"/notes/n6":{"owner":"<UID>","createdAt":1}}},
    {"description":"a player with every field valid","expectation":"ALLOW","operation":"write","opPath":"/players/<UID>","authPresent":true,"newData":{"name":"Al","level":3,"handle":"al_1"}},
    {"description":"a name over the maximum length","expectation":"DENY","operation":"write","opPath":"/players/<UID>","authPresent":true,"newData":{"name":"abcdefghijklm","level":3}},
    {"description":"a level written as a string","expectation":"DENY","operation":"write","opPath":"/players/<UID>","authPresent":true,"newData":{"name":"Al","level":"3"}},
    {"description":"a handle that does not match the pattern","expectation":"DENY","operation":"write","opPath":"/players/<UID>","authPresent":true,"newData":{"name":"Al","level":3,"handle":"Al!"}},
    {"description":"a player with a field outside the shape","expectation":"DENY","operation":"write","opPath":"/players/<UID>","authPresent":true,"newData":{"name":"Al","level":3,"admin":true}},
    {"description":"a player missing a required field","expectation":"DENY","operation":"write","opPath":"/players/<UID>","authPresent":true,"newData":{"name":"Al"}},
    {"description":"a like adds one","expectation":"ALLOW","operation":"write","opPath":"/stats/s1/likes","authPresent":true,"newData":6,"seed":{"/stats/s1/likes":5}},
    {"description":"a like count that jumps by two","expectation":"DENY","operation":"write","opPath":"/stats/s2/likes","authPresent":true,"newData":7,"seed":{"/stats/s2/likes":5}},
    {"description":"a step-checked count created with nothing stored","expectation":"DENY","operation":"write","opPath":"/stats/s3/moves","authPresent":true,"newData":1},
    {"description":"a better best score","expectation":"ALLOW","operation":"write","opPath":"/stats/s4/best","authPresent":true,"newData":12,"seed":{"/stats/s4/best":10}},
    {"description":"a worse best score","expectation":"DENY","operation":"write","opPath":"/stats/s5/best","authPresent":true,"newData":9,"seed":{"/stats/s5/best":10}},
    {"description":"a score created at 0 to 0","expectation":"ALLOW","operation":"write","opPath":"/scores/g1","authPresent":true,"newData":{"host":0,"guest":0}},
    {"description":"a goal for the host","expectation":"ALLOW","operation":"write","opPath":"/scores/g2","authPresent":true,"newData":{"host":3,"guest":1},"seed":{"/scores/g2":{"host":2,"guest":1}}},
    {"description":"a goal for both sides at once","expectation":"DENY","operation":"write","opPath":"/scores/g3","authPresent":true,"newData":{"host":3,"guest":2},"seed":{"/scores/g3":{"host":2,"guest":1}}},
    {"description":"an unguarded step adds 1 to nothing stored","expectation":"DENY","operation":"write","opPath":"/probes/nullstep","authPresent":true,"newData":1},
    {"description":"adding 1 to nothing stored, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullsumor","authPresent":true,"newData":1},
    {"description":"adding 1 to nothing stored is not 1","expectation":"DENY","operation":"write","opPath":"/probes/nullsumne","authPresent":true,"newData":1},
    {"description":"adding nothing stored to 1, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullright","authPresent":true,"newData":1},
    {"description":"subtracting 1 from nothing stored, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullsub","authPresent":true,"newData":1},
    {"description":"multiplying nothing stored by 2, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullmul","authPresent":true,"newData":1},
    {"description":"adding a string to nothing stored, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullconcat","authPresent":true,"newData":1},
    {"description":"negating nothing stored, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullneg","authPresent":true,"newData":1},
    {"description":"comparing nothing stored with 1, then or true","expectation":"DENY","operation":"write","opPath":"/probes/nullcompare","authPresent":true,"newData":1},
    {"description":"a board created with no stored turn","expectation":"ALLOW","operation":"write","opPath":"/boards/b1","authPresent":true,"newData":{"players":{"0":"<UID>","1":"seat-one","2":"seat-two"},"turn":0}},
    {"description":"a join that also rewrites rematchOf","expectation":"DENY","operation":"update","opPath":"/matches/j4","authPresent":true,"newData":{"guest":"<UID>","status":"playing","rematchOf":"other"},"seed":{"/matches/j4":{"host":"player-two","guest":"","status":"waiting","currentTurn":"host","winner":"","moveCount":0,"rematchOf":"f0"}}},
    {"description":"a server timestamp where the rule requires now","expectation":"ALLOW","operation":"write","opPath":"/probes/stamp","authPresent":true,"newData":{".sv":"timestamp"}},
    {"description":"a client time where the rule requires now","expectation":"DENY","operation":"write","opPath":"/probes/stamp","authPresent":true,"newData":1000000000000},
  ],
};
