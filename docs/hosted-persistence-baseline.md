# Frozen persistence performance gates

Reference: Apple M3 Pro, 18 GiB RAM, Node 22.15.0, SQLite 3.49.1,
local macOS filesystem; source commit 470ba3d4. Frozen before backend implementation.
Raw browser samples: hosted-persistence-baseline.json.

## Stable load

Three 60-second real-browser runs: 50 writes/sec, 100 rotating documents,
256 bytes padding plus changing sequence, 64 maximum pending requests. All
9,000 writes completed, zero service errors and zero harness refusals.
Acknowledgment p95: 8.9, 9.3, 11.9 ms. Worst observed ten-second host event-loop
p95: 4.382719 ms (1 ms histogram resolution; startup window excluded).

Acceptance: each matching run completes every offered operation with no errors
or harness refusals; acknowledgment p95 <=25 ms and maximum ten-second host
loop p95 <=4.382719 ms. Record throughput and memory as well. The absolute 25 ms
acknowledgment budget was chosen before the third run/backend implementation,
using measured request cost, SQLite durable commit cost and queueing headroom;
it is not a claim that JSON and SQLite offer equal durability.

Node WAL/FULL probe with changing bytes: 1,000 measured 4 KiB writes per run,
three runs, p95 0.055-0.073 ms; twenty 8 MiB replacements per run, p95 18-21 ms.
These are commit costs, not network latency or a power-loss test.

## Overload case (pre-existing failure; still required at acceptance)

200 offered writes/sec for 60 seconds, same document size and pending cap:
10,726 completed, 0 service errors, 1,254 harness refusals from 11,980 offered;
p95 acknowledgment 361.6 ms. This is FAILED, not a latency baseline.
Repeat it after implementation and report its complete outcome. A saturated
baseline cannot justify relaxing correctness or dropping work. Zero refusals
and errors remain necessary to claim this load is supported.

## Startup

Preliminary in-process JSON restore of 100 documents: 2.0-4.1 ms. Record both
host startup and payload validation on the same persisted size after changes;
these timings are observations, not an invented hard startup SLA.

Run the checked-in browser harness with PYRIC_BASELINE_RATE=50 and a supported
Node executable. Default rate 200 retains the overload workload. Every host,
browser context and temporary project must be closed and removed on failure.
