---
package: "@zakkster/lite-crdt"
version_target: 2.0.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: []
depends_on: [C4]
decision: decisions/0006-rga-sequence.md
---

# C5 — lite-crdt v2.0.0 — doc.list(name): RGA positional sequence

## PURPOSE

The order-of-magnitude item and the sole 2.0 headline: a convergent positional
sequence with insert-at-index and move-to-index (RGA / Replicated Growable
Array). This is the original roadmap's declared 2.0, now built on a base that is
validated (C1, the remote-op door), deterministic (C2, prototype-safe + sorted
serialization), identity-safe (C3, genReplicaId + provided-id validation C-20),
and compactable (C4, version-vector tombstone GC + delta sync).

It ships ALONE as 2.0.0. lite-room interop (RGA as a room storage type) is 2.1,
AFTER the core sequence has soaked -- not bundled in. Plan this as its own
multi-session sub-arc (like the signal 1.9 rebuild), not a single coder pass.

## WHY 2.0 (the one breaking-change budget)

The three existing collections (LWWMap, ORSet, PNCounter) do not change their
wire format or convergence algebra. RGA is a NEW collection kind (`doc.list`)
with NEW op types. The major bump exists to (a) reserve room for the new op
envelope in the shared applyOp/mergeState door and (b) let the planner decide
whether any existing surface (e.g. `doc.array` ordering docs, the `getState`
shape, kind inference in `applyOp`) must shift to accommodate a positional kind
-- and to make any such shift a deliberate, documented 2.0 act rather than a
silent break. If the core three can stay byte-identical, the brief should say so
and confine the break to the additive `list` surface.

## TASKS (planner expands into atomic sub-tasks across the sub-arc)

- **RGA element identity + total order.** Each inserted element gets a unique,
  immutable id `(lamport, replicaId)` (reuse the existing Lamport clock and the
  C3 replicaId). Convergent order is by the RGA rule: an insert names its LEFT
  origin (the element it was typed after), and concurrent inserts at the same
  origin break ties by `(lamport, replicaId)` descending -- the standard RGA /
  Logoot-free ordering that needs no dense position keys.
- **Convergent insert-at-index.** `list.insert(index, value)` resolves the index
  to a left-origin id at emit time; the op carries the origin, not the index, so
  it converges regardless of what concurrent edits did to the numbering.
- **Convergent move-to-index.** `list.move(fromIndex, toIndex)`. The planner must
  decide the model: a move as delete+reinsert (simplest, but loses identity and
  can duplicate under concurrency) vs a move as a first-class op with
  last-writer-wins on a per-element position register (identity-preserving; the
  known-correct choice, mirroring how ORSet keeps a value register). Argue it in
  the decision doc; concurrent moves of the SAME element must converge to one
  position, and a move concurrent with a delete must not resurrect.
- **Delete + tombstones.** `list.delete(index)` / `deleteById(id)`. RGA keeps a
  tombstone per removed element (an element's id must remain as an insertion
  anchor for concurrent inserts that named it as origin). These tombstones are
  the C4 compaction target -- `compact(V)` must reclaim an RGA tombstone once the
  frontier proves no concurrent insert can still name it as origin (causal
  stability of the anchor, not just the element).
- **The door.** Every remote RGA op (`insert`, `move`, `delete`) validated by the
  SAME reject-and-continue discipline as C1 before it touches state: single-read
  of the untrusted payload (C-18), fail-closed on a non-finite/ceiling lamport, a
  missing/oversized origin, a non-string replicaId, a prototype-poison id. A bad
  RGA frame is dropped to onError, never applied, never crashes the list.
- **The projection.** `list.store` is a read-only reactive lite-store array
  projection, deep-guarded like ORSet's; reactive reads (`at`, `values`, `size`)
  and mutations (`insert`/`move`/`delete`) mirror the existing collection shape.
- **Serialization.** `getState`/`mergeState`/`getStateSince` extended to the list
  kind over `Object.create(null)`, key-sorted for byte-identical converged output
  (the C2 invariant), delta-filterable by version vector (the C4 contract).

## THE GATES (unchanged discipline, new surface)

- **Zero-alloc apply.** `applyOp` of an RGA insert/move/delete allocates 0 B on
  the steady-state hot path (T6, maxMajor:0 / maxArrayBuffersGrowth:0). Index
  resolution on the LOCAL emit path may allocate; the REMOTE apply path may not.
- **Differential fuzz against a reference oracle (T5).** A straightforward
  array-with-tombstones reference implementation of RGA; random interleaved
  insert/move/delete streams across N replicas, delivered in random order with
  duplication, must converge to the SAME sequence as the oracle. This is the
  load-bearing proof -- RGA convergence is subtle (the origin-tie rule and the
  move register are where textbook implementations diverge).
- **Retention / compaction soak (T7).** A long churn (insert/delete storm) with
  periodic `compact(V)` must bound live RGA memory to O(live elements), not
  O(total inserts ever), and never resurrect a compacted anchor.

## ASSERTIONS (falsifiable; planner adds the rest)

- Two replicas that apply the same set of RGA ops in ANY order and with arbitrary
  duplication converge to byte-identical `getState()` and identical `values()`.
- Concurrent inserts at the same origin order deterministically by
  `(lamport, replicaId)`, identically on every replica.
- A move concurrent with a delete of the same element leaves it deleted (delete
  wins or move-wins -- whichever the decision doc picks -- but ALL replicas agree).
- Two concurrent moves of the same element converge to ONE position.
- `getStateSince(V)` + a peer at `V` == full `getState()` for any V, including
  lists.
- `compact(V)` never changes the converged sequence vs an uncompacted control,
  and reclaims RGA tombstones once causally stable.
- Zero-alloc gate green for insert/move/delete apply.

## NON-GOALS

- No rich text / CRDT string with per-character formatting (a list of characters
  is expressible but not the target; formatting attributes are out).
- No lite-room storage-type interop -- that is 2.1, after soak.
- No dense-position / Logoot / fractional-index scheme -- RGA origin-linking is
  the chosen model; the decision doc records why (no unbounded key growth).

## DONE WHEN

`doc.list` converges under reorder / duplication / concurrent move+delete;
fuzz-proven against the oracle across seeds and SCALE; the C1 door and the T6
alloc gate hold for every RGA op; RGA tombstones compact under C4; shipped ALONE
as 2.0.0 with the core-three wire format documented as unchanged (or the break
documented if not). decisions/0006-rga-sequence.md records element identity, the
move model, the origin-tie rule, and the compaction-anchor stability argument.
