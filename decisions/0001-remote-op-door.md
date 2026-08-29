# 0001 — the remote-op validation door: reject-and-continue

Status: **accepted** (policy locked 2026-08-30; implemented in v1.1.2 / session C1)
Findings: C-01, C-02, C-03, C-04, C-05, C-06, C-07

## Context

`applyOp` / `applyOps` / `mergeState` are the receive path: they process bytes
from another replica, which is untrusted input. Today they validate only the op
*envelope* (`t` and `c` are strings, `CRDT.js:830`) and trust every field that
drives convergence — `l`, `r`, `p`, `n`. Seven reproduced findings follow, four
of them silent S1 corruption (see ROADMAP.md sec. 3).

`llms.txt` already states the intent for one key: an incoming op with a
`__proto__` key "is ignored ... a peer must not be able to crash us." This
decision extends that single sentence to the whole remote surface.

## Options considered

- **A. Throw.** A malformed op raises `CRDTError(malformed_op)` and `applyOps`
  aborts. Simplest, but a peer can still halt a batch mid-apply (this is exactly
  C-05), leaving a partially-applied prefix. It turns the crash into a feature.
- **B. Reject-and-continue.** Each op is validated at the door; a bad op is
  dropped and routed to `onError`, the batch continues, and the doc is left
  byte-identical to a run that never saw the bad op. `applyOps` never throws on
  a malformed frame.

## Decision

**B — reject-and-continue.** It is the only option consistent with the package's
own stated contract that a peer must not be able to crash the receiver, and it
makes `applyOps` atomic per op rather than per batch. The door returns a boolean;
`apply` proceeds only on `true`; a rejected op is reported to the `onError` hook
(never thrown out of `applyOps` / the BroadcastChannel `onmessage` path).

`mergeState` gets the same discipline: a malformed collection or register is
rejected (reported), not applied and not crashed.

## Consequences

- The door is the single validation choke point. The local mutation API is
  already hardened (`counterStep`, the `__proto__` guard, monotonic ticks) and
  does not change.
- The door runs on the receive path, so it may cost a few scalar comparisons per
  op, but it must add **zero allocation** and must not touch `emit`, `apply`'s
  happy path, or `reconcile` (proven by the T6 alloc gate against the C0
  baseline).
- Every finding gets a fails-before / passes-after test that also asserts
  `validate(doc)` and a byte-identical snapshot vs a clean run (torture tier T4).
- The T5 convergence fuzz gains an adversarial-op stream: injected malformed ops
  must be rejected without diverging any replica — the coverage the existing
  fuzzer structurally lacks.

## The clock ceiling (C-07)

`l` is bounded to a finite number `< 2^53` at the door, and local `tick()` fails
closed (throws) rather than silently saturating if it ever reaches the ceiling.
2^53 is the ceiling because above it `++lamport` is a float no-op and the total
order collapses to the replicaId tiebreak.
