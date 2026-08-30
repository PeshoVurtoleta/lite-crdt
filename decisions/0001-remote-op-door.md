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
rejected (reported), not applied and not crashed. Its `okState` set-branch also
cross-checks that every live add-id carries a value register: a well-formed
`getState()` always satisfies this (`apply("add")` always calls `setValue`), but
a crafted `{ adds: { x: {...} }, values: {} }` would otherwise pass the
independent shape checks and then crash `rebuildProjection` reading `.v` off an
absent register -- a fail-open corruption that re-emits the poison in the next
`getState()`. Rejecting it at the door is the fix.

### applyOp is STRICT; applyOps is RESILIENT

Two receive entry points, two contracts:

- **`applyOp` (single) stays STRICT.** A non-op envelope (`t`/`c` not strings) or
  an unknown op type throws `CRDTError(malformed_op)`. This is the local
  programmer-error surface -- a hand-built bad op should fail loudly at the call
  site (and it is what `llms.txt` documents). Malformed *fields* and a
  kind-mismatch are still reject-and-continue inside `applyOp` (reported, not
  thrown), because those are the untrusted-peer vectors.
- **`applyOps` (batch) is RESILIENT.** It must never throw on one bad frame: each
  op is wrapped so a strict throw (non-op / unknown type) is caught, routed to
  `onError`, and the batch continues -- every good frame still applies. This is
  the transport-safe path a custom transport (and `connectBroadcastChannel`)
  relies on: a crafted frame can never abort a batch mid-apply.

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

## Single-read at the door (C-18, TOCTOU)

The door must read each untrusted scalar **exactly once**. The original split --
`okState`/`okOp` validate a field, then `mergeState`/`_apply` re-read the same
field at use -- is a time-of-check-to-time-of-use hole: an untrusted payload that
is a *live object* (an accessor, a `Proxy`, a lazily-computed field) returns a
benign value to the validator and a poison value to the merge, reintroducing
C-01/C-02/C-03 past the door with zero `onError`.

- **`mergeState`:** `okState` is reduced to a cheap top-level container-shape
  check. All scalar validation moved into each collection's `_mergeState`, which
  reads every register/scalar once into a local, validates the local, and merges
  from that same local. The set path also re-checks the live-add-id -> value
  invariant against the *actual merged Maps* (immune to a source re-read) so
  `rebuildProjection` cannot dereference an absent value register.
- **`applyOp`:** the untrusted op is copied field-by-field into a pre-allocated,
  doc-owned scratch op (each field read once); validation, the clock merge, and
  `_apply` then read only the scratch. Closed airtight with **zero per-op
  allocation** (the scratch is reused, preserving the T6 gate) and without
  touching the shared `apply()` or the local mutation API. Reuse across reentrant
  `applyOp` is safe because every `apply()` reads all its op fields before it
  fires `ctx.changed()`, so a nested call cannot clobber a field an outer call
  has yet to read.

## The clock ceiling (C-07)

`l` is bounded to a finite number `< 2^53` at the door, and local `tick()` fails
closed (throws) rather than silently saturating if it ever reaches the ceiling.
2^53 is the ceiling because above it `++lamport` is a float no-op and the total
order collapses to the replicaId tiebreak.
