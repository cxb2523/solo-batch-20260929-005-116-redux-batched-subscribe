# Batched Subscribe Trace Contract

This document is the machine-checked contract for the tracing wrapper in
`src/batchedSubscribe.trace.js`. `scripts/trace-batching.js` replays both paths
with an injected fake clock (each `work` listener advances the clock) and an
injected scheduler, then compares its printed rows against the tables below
**line by line**. Any mismatch (order, call count, or duration bound) makes the
script exit non-zero.

Columns:

- `path` — `sync` uses the immediate scheduler (every dispatch is one round);
  `async` uses a fake coalescing scheduler that defers notifications to the next
  tick and merges every dispatch issued in the same tick into a single round.
- `round` — notification round number (the `notifying` scope; an async flush
  starts a fresh round).
- `ordinal` — 1-based position of the listener inside that round's
  `currentListeners` snapshot.
- `listener` — registered listener name.
- `calls` — cumulative number of times that listener has been invoked so far.
- `duration` — measured milliseconds for that single listener invocation.
- `maxDuration` — inclusive upper bound the measured `duration` must satisfy.

Snapshot semantics: listeners added or removed while a round is notifying only
touch `nextListeners`. The in-flight round keeps iterating the frozen snapshot,
so removals are still invoked once in the current round and additions are absent
from it; the next round observes the change. No per-listener conditional patching
is involved — the trace reads the exact snapshot iterated by `notify()`.

## Trace rows

| path  | round | ordinal | listener | calls | duration | maxDuration |
| ----- | ----- | ------- | -------- | ----- | -------- | ----------- |
| sync  | 1     | 1       | a        | 1     | 2        | 50          |
| sync  | 1     | 2       | b        | 1     | 3        | 50          |
| sync  | 1     | 3       | c        | 1     | 1        | 50          |
| sync  | 2     | 1       | a        | 2     | 2        | 50          |
| sync  | 2     | 2       | c        | 2     | 1        | 50          |
| async | 3     | 1       | a        | 1     | 2        | 50          |
| async | 3     | 2       | b        | 1     | 3        | 50          |
| async | 4     | 1       | a        | 2     | 2        | 50          |
| async | 4     | 2       | b        | 2     | 3        | 50          |
| async | 4     | 3       | d        | 1     | 1        | 50          |

## Round totals

| path  | dispatched | rounds | listeners in last round |
| ----- | ---------- | ------ | ------------------------ |
| sync  | 2          | 2      | 2                        |
| async | 3          | 2      | 3                        |

## Scenario notes

- Sync: two immediate dispatches produce two rounds (no coalescing). During
  round 1, `b` unsubscribes itself, so round 1's frozen snapshot still invokes
  `a`, `b`, `c` at ordinals 1-3; round 2's snapshot only contains `a` and `c`.
- Async: two dispatches issued in the same tick are coalesced into round 3 and
  every listener runs only once (`calls` advances by one, not by the number of
  dispatches). Listener `d` is subscribed during round 3, so it is absent from
  round 3's snapshot (`a`, `b` only). A later single dispatch produces round 4,
  whose snapshot contains `a`, `b`, and `d`.
- Every measured duration is small and bounded: no single listener invocation
  may exceed its `maxDuration` (50ms under the fake clock).



