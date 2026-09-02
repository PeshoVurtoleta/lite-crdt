# 0006 -- RGA positional-sequence list (`doc.list`)

Status: **accepted** (implemented in v2.0.0 / sessions C5.1..C5.5)
Feature: `doc.list(name)` -- a fourth CRDT collection, an RGA (Replicated Growable
Array) positional sequence with `insert`/`delete`/`deleteById`/`move`, `values`,
`ids`, `size`, `snapshot`, a read-only `.store` projection, and full state-based
sync (`getState`/`mergeState`/`getStateSince`/`compact`). New wire ops
`lins`/`ldel`/`lmv`.
Related: C1 (the remote-op door, decisions/0001), C2 (retention + prototype-safe
names, decisions/0002), C4 (compaction + delta, decisions/0004).

C5 is a FEATURE arc, and the ONLY 2.0 breaking change is forward-only and confined
to the three new op types (see "The one break", last section). The core-three
convergence algebra, wire format, door branches and compaction bytes do NOT change;
this whole arc is additive on the new `list` kind, proven byte-identical to 1.3.1
by a golden fixture (`test/27-golden-core-three.test.mjs`).

## The model -- two layers, one record

A list element is not a bare value at a mutable index; it is an **identity** with a
**position**. RGA separates the two.

- **Anchors.** An anchor is an immutable id `(l, r)` (`l` a Lamport stamp, `r` the
  writer's replicaId) with an ORIGIN `(or, ol)`. Its position in the sequence is
  fixed FOREVER at integration by the RGA scan:

  ```
  integrate(node, origin):
     x = origin.next
     while x != null and cmpOK(x.l, x.r, node.l, node.r) > 0:  x = x.next
     link node before x
  ```

  i.e. from the origin, skip every already-linked node whose order key is STRICTLY
  GREATER, then link before the first that is not. Concurrent same-origin inserts
  thus DESCEND by `(lamport, replicaId)`: the higher `(l, r)` lands first. `or ===
  null` marks the HEAD sentinel. The comparator DIRECTION is load-bearing -- a
  flipped `>` gives ascending ties and a different (still-deterministic but wrong)
  order; T9 control rga-1 pins it, and T5's independent oracle catches it.

  Equivalently, the total order is the **causal-tree preorder**: visit each origin,
  then its children in descending `(l, r)`, recursively. The T5 oracle renders by
  exactly this preorder over an independent anchor set -- no linked list -- so it
  and the implementation reach the same sequence by different roads or the gate
  fails.

- **Elements.** An element's identity is its **birth anchor** id `(bl, br)`. It
  carries a monotone `del` flag (with the remover stamp `(dl, dr)`) and an LWW
  **position register** `(ml, mr) -> anchorKey` naming the anchor it currently
  displays at (its birth anchor until moved, then the winning move anchor).

## MOVE = a first-class LWW anchor-valued position register

`lmv` is NOT delete+reinsert and NOT an element-relative pointer. It is a first-
class LWW register whose VALUE is drawn from the anchor space:

- `applyLmv` UNCONDITIONALLY mints + integrates a fresh anchor at the destination
  origin, whose id IS this move's own `(l, r)` -- so a concurrent insert that names
  this move's anchor as its origin still lands, win or lose.
- It then CONDITIONALLY writes the element's register under `tsWins(l, r, ml, mr)`:
  only a move that beats the element's current register stamp relinks the element
  (splice out of the old visible position, splice into the new). A losing move
  leaves its minted anchor ABANDONED -- occupying no element, so it never inflates
  `count` or the projection.

An element's initial register stamp is its birth `(bl, br)`, and any move's lamport
is strictly greater, so the first move always beats birth.

### Rejected alternatives (and why)

- **Delete + reinsert.** Duplicates the element under a concurrent move-of-the-same-
  element (two reinserts, two survivors); orphans any concurrent insert that named
  the element's old anchor; and costs one tombstone per move (unbounded). An LWW
  register keeps ONE identity and ONE winner.
- **Element-relative move registers** (`X.after(Y)`). `X.after(Y) || Y.after(X)` is
  a cycle with no deterministic linearization -- two replicas can disagree on which
  element leads. Anchor-VALUED registers are cycle-free by construction: the value
  is a fixed point in the anchor total order, not a live element that can move.

### Convergence of the hard cases

- **Concurrent moves of one element** -> exactly one winner (`tsWins`), one abandoned
  anchor, on every replica (T9 rga-2, T5).
- **Move || delete COMMUTE** because they write DISJOINT fields: the monotone `del`
  flag vs the LWW register. Delete always wins (a moved element stays invisible; a
  move never resurrects a deleted one). Resurrection is UNREPRESENTABLE -- there is
  no op that clears `del`.

## Out-of-order is PENDING, never dropped

- An `lins`/`lmv` whose destination ORIGIN anchor is unseen goes into a capped
  pending map keyed by `(or, ol)`, drained when that origin integrates.
- An `ldel`/`lmv` for an element whose BIRTH `lins` is unseen records a placeholder
  (born-dead / born-moved) keyed by the birth anchor, folded in when the `lins`
  integrates (disjoint fields, so both a pending delete and a pending move reconcile
  on the newborn and commute).

Dropping instead of pending would DIVERGE under reorder (a late insert would
resurrect a deleted element; a reordered child would be silently lost). The buffers
share one `PENDING_MAX` (4096) budget and fail closed on overflow (`onError` +
drop) -- a crafted never-arriving-origin flood cannot grow memory unbounded (RISK
#5). T9 rga-3 pins pend-not-drop.

## Serialization -- re-integrate, never trust a transmitted order

State shape (`Object.create(null)`, keys SORTED, split on `lastIndexOf("#")` since a
replicaId may itself contain `#`):

```
{ kind:"list",
  nodes:{ "r#l":[or,ol] },
  elems:{ "br#bl":[ml,mr,anchorKey,del,dl,dr,v] } }
```

`_mergeState` RE-RUNS RGA integration from origins in ASCENDING `(l, r)` order: a
node's origin always has a strictly lower lamport, so the origin is present by the
time the node integrates. It NEVER trusts a transmitted sibling order (it re-runs
the same `integrate` scan the live path uses), so an omitted or adversarial order
cannot change convergence. A node whose origin never arrives is an ORPHAN -> dropped
+ reported (fail closed). Every incoming field passes the same door discipline
(finite/ceiling lamports, non-empty string ids), validated AT USE (the anti-TOCTOU
single-read, matching the core-three branches). All three occupancy-write sites
(fresh-birth `e`, born-moved `dest.e`, LWW relink) fail closed against a crafted
co-occupant: a write that would evict a live element is reported and dropped, never
applied (Fix B, C5.5).

`_getStateSince(V)` ships a node when `node.l > V[node.r]` and an element when ANY
of its three stamps -- birth `(bl,br)`, register `(ml,mr)`, remover `(dl,dr)` --
beats `V[thatWriter]`. Per-writer delta filtering IS sound here (the 0004 OR-Set
`removed` hazard does NOT recur) because the reshaped record stores each mutation's
OWN writer: `ldel` stamps the remover, `lmv` the mover, `lins` the inserter.

## Anchor compaction -- the stricter condition

A plain LWW/OR tombstone is reclaimable at `l <= minAck` (everyone has seen it, so
nothing can still lose to it). For an ANCHOR, `l <= minAck` is exactly the condition
that every replica MAY NOW NAME IT AS AN ORIGIN: necessary, but NOT sufficient. Two
tiers:

- **Tier 1 (always, at `minAck`).** An element whose delete AND register stamps are
  both causally stable (`del && dl <= minAck && ml <= minAck`) has its payload `v`
  and record dropped, KEEPING the bare anchor node `{l, r, prev, next, or, ol}` --
  it may still be named as an insertion origin. Reclaims the unbounded element
  bytes, leaves the origin skeleton.

- **Tier 2 (anchor UNLINK, only under global quiescence).** `minAck >=
  max(V.values()) && minAck >= doc.clock()` => no op naming any anchor can still be
  in flight => every truly-unoccupied anchor is unlinkable. This is the ONLY sound
  discharge of "no future op names anchor A" from a version vector. A single lagging
  replica (`minAck < max`) or a local op ahead of the frontier (`minAck < clock`)
  leaves `quiesced` false and Tier-2 does NOT unlink -- unlinking then would let the
  laggard's concurrent op resurrect the anchor (RISK #4; T9 rga-4 pins that an
  unsound unlink loses/resurrects data).

  Even under quiescence, an anchor is unlinked ONLY if it is truly unoccupied
  (`e === null`), is no live element's birth home (`born === null`), AND is not
  still named as an origin by any surviving node. This **origin-leaf guard** is a
  soundness necessity, not a nicety: a node stores its origin and `_mergeState` re-
  integrates from it, so unlinking a still-named anchor would DANGLE that dependent's
  origin and orphan it (a LIVE dependent would be dropped) on the next round-trip. A
  non-leaf tombstone is reclaimed on a LATER `compact()` once its dependents are
  themselves reclaimed -- **progressive, cascade-free per call**.

### The `size + 1 + U` bound

After compacting to a fixpoint under quiescence, the anchor census settles to
`elems + justified` (`<= size + 1 + U`, the `+1` covering the HEAD sentinel), where
U (`justified`) is the count of display-unoccupied anchors that are still JUSTIFIED:
a still-live moved element's birth home (`born !== null`), or an anchor still named
as an origin by a surviving node. Every UNJUSTIFIED unoccupied anchor is unlinked
(the `reclaimable` census -> 0 at the fixpoint). U is O(live), not O(ops); a never-
compacted control grows O(ops). Do NOT expect the tight `size + 1` after a SINGLE
quiescent compact: a live element chaining off a reclaimable anchor keeps that
anchor referenced until the chain drains over successive passes. T7 gates this bound
and the no-resurrection property; the `_retention()` probe exposes
`{anchors, elems, pending, unoccupied, reclaimable, justified}`.

This quiescence contract is the caller obligation stated in llms.txt alongside the
0004 no-redelivery-below-frontier assumption: `compact(V)` MUST be given the
pointwise-min version vector across ALL replicas.

## Hot-path discipline

Remote `lins`/`ldel`/`lmv` apply is pointer surgery on the doc-owned `scratchOp`
(extended with `ol, or, bl, br`, all copied in the single-read block). The two-level
`Map(r -> Map(l -> node))` id index means ZERO string concatenation on apply;
string keys exist only on the cold serialize/reorder paths. A redelivered op short-
circuits on the index with no scan and no allocation (the T6 steady-state 0-B path).
First delivery mints exactly one node + element (+ one index entry + one projection
slot): a flat O(1) ~242-252 B/op, measured separately against a calibrated
regression ceiling, never conflated with the 0-B redelivery claim. Every apply reads
all its scratch fields into stack locals BEFORE `ctx.changed()`, since a `'change'`
listener may reentrantly `applyOp` and clobber the shared scratch (reentrancy
discipline). The doc-level `mergeState` loop re-checks `disposed` between collections
so a reentrant mid-merge `dispose()` cannot leave a zombie collection (Fix A, C5.5).

## The one break (forward-only)

A 1.x replica's `applyOp` throws `malformed_op` on any `lins`/`ldel`/`lmv` frame,
and its `mergeState` drops a `kind:"list"` state. A 2.0 replica is a strict
SUPERSET; a 1.x replica simply cannot consume list frames. That is the entire 2.0
break -- deliberate and confined to the new op types. Everything else is byte-
identical to 1.3.1.
