# 0004 -- tombstone compaction + delta sync

Status: **accepted** (implemented in v1.3.0 / session C4)
Feature: `doc.versionVector()`, `doc.compact(V)`, `doc.getStateSince(V)`; the
OR-Set `removed` set becomes a `Map(tagKey -> rmLamport)` internally (still
SERIALIZES as the sorted key array -- wire byte-compatible, no new op type).
Related: C0 (v1.1.1), C1 (v1.1.2, the remote-op door, decisions/0001), C2 (v1.2.0,
retention + prototype-safe names, decisions/0002) and C3 (v1.2.1, undo + replica
identity, decisions/0003).

C4 is a FEATURE session, but a narrow one. **The convergence algebra of the base
CRDTs does NOT change.** Compaction only RECLAIMS causally-stable tombstones and
value registers -- state that no future op can still need. The C1 door validation
and the C2/C3 logic are EXTENDED, never rewritten. This document anchors the
session: it fixes the exact safety condition, argues convergence is preserved,
and records the `Set -> Map` migration and its fail-closed default.

## The seam this opens (from C2)

decisions/0002 named the seam precisely: keeping `valueReg` and the `removed`
tombstone set is what makes retention O(distinct ids seen) rather than O(live
ids) across a doc's lifetime. Letting them go "requires knowing an op can no
longer arrive out of order -- a version-vector / causal-stability check. That
check is the seam C4 widens." This is that check.

## The version vector

The doc tracks `vv: Map(replicaId -> maxLamportObservedFromThatWriter)`.

- A local write advances `vv[replicaId]` in `tick()`.
- `applyOp`, AFTER the door validates the untrusted op into the scratch and
  merges the clock, does one in-place max: `observe(s.r, s.l)`. This is the ONLY
  new per-op work. It is O(1) and ZERO-ALLOCATION: `vv.set(r, l)` on an existing
  replicaId key allocates nothing, and the Map grows only on a genuinely new
  writer (bounded by replica count, not op count), so steady state is 0 B/op (the
  T6 gate). Counter ops (`cinc`/`cdec`) carry no Lamport stamp (`s.l` is
  `undefined`), so `observe` skips them -- vv tracks lamport only.
- `mergeState` calls `ctx.observe(r, l)` for every register/tag/value lamport it
  absorbs, symmetric with C1's C-19 clock advance -- so a doc hydrated purely by
  full-state sync still has an accurate vv.

`versionVector()` returns a prototype-free, JSON-serializable snapshot COPY, safe
to hand a peer.

### Why counters do NOT participate in the version vector or the delta condition

PN-counters converge by max, not by a total order; they carry no lamport. There
is nothing to make stale and nothing to reclaim. A delta therefore ships counters
FULL (`_getStateSince` falls back to `_getState` for the counter kind): P/N are
small per-replica cumulatives and merge is idempotent max, so always-including
them is correct and simplest. `compact()` on a counter is a no-op returning 0.

## The compaction safety condition (PRECISE)

A tombstone with order `(l, r)` is causally stable -- droppable -- iff every
replica has observed it. Given a version vector `V` that is the pointwise-min
across all replicas (`V[k] = min over peers of what each has seen from writer k`),
the tightest per-writer statement of "everyone has seen writer r's op at lamport
l" is `l <= V[r]`.

**Implemented condition: the CONSERVATIVE global frontier**
`minAck = min(V.values())` (0 when V is empty); **drop a tombstone with lamport
`l` iff `l <= minAck`.** This is `l <= V[r]` for every writer r at once, because
`minAck <= V[r]` for all r.

### Why the conservative min, not the tighter per-replica `l <= V[r]`

The per-replica form is NOT sound for either collection, because a tombstone's
competitor is a write from a DIFFERENT replica, and per-replica keys only on the
tombstone's own writer:

- **LWW-Map.** A tombstone `(l_t, r_t)` for key k competes with `set` ops for k.
  Suppose `V[r_t] >= l_t` (per-replica says: drop). But a concurrent
  `set(l_s < l_t, r_s)` from another replica r_s is still in flight (`V[r_s] < l_s`,
  not yet delivered everywhere). Drop the tombstone; later that set arrives and
  RE-CREATES key k, while an uncompacted peer still has the tombstone and the set
  loses to it. The two diverge and no later op reconciles them. The min rules it
  out: `l_t <= minAck <= V[r_s]` forces the competing set (`l_s < l_t <= minAck`)
  to be itself stable -- already delivered everywhere and already lost -- so it
  cannot still arrive.
- **OR-Set.** A `removed` tombstone for tag `T = r_add # n` suppresses re-adds of
  T. Two frontiers must both hold to drop it safely: every replica must have seen
  the REMOVAL (so no peer holds T as a live add whose state-sync would resurrect
  it), and the ADD must be stable (so no delivery re-introduces T). The tombstone
  stores the removing op's lamport `l_rm` (any remover observed the add first, so
  `l_add < l_rm`). A single number `minAck` covers both: `l_rm <= minAck <= V[r_rm]`
  gives "everyone saw the removal", and `l_add < l_rm <= minAck <= V[r_add]` gives
  "the add is stable". The adder's r is parseable from the tagKey and the
  remover's is not, so no single per-replica key expresses both frontiers -- the
  global min does, in one comparison.

So for these CRDTs the conservative min is not merely "safe but less aggressive";
it is the correct single-scalar frontier. The convergence fuzz (t5) is the proof:
a replica compacting at min-frontiers stays byte-identical to an uncompacted
control over the same op stream.

## Convergence-preservation argument

Dropping a causally-stable tombstone cannot change any future converged state.

A tombstone exists to make a concurrent op LOSE (a suppressed re-add, a delete
that beats a lower-lamport set). It is dropped only once `minAck` proves every
replica has observed it AND every op it could still have to arbitrate is itself
stable -- already delivered to every replica and already resolved. After that
point:

- No peer can send a state whose live set still contains a tag this tombstone
  suppressed (every peer saw the removal too).
- No delivery can carry an op with a lamport at/below the tombstone's competitor
  frontier (those ops are `<= minAck`, hence already delivered everywhere under
  the causal-delivery assumption the version vector encodes; a transport that
  re-delivers acknowledged ops from before the frontier violates that assumption,
  exactly as it would violate at-most-once for any vector-clock GC).
- Any FUTURE op for the same key/id/tag necessarily carries a HIGHER lamport (its
  writer observed the now-stable state, so its clock is beyond it) and therefore
  wins whether or not the tombstone is still present -- keeping vs dropping the
  tombstone yields the identical result.

**The failure mode avoided:** dropping a tombstone that a lagging peer's
concurrent add still needs to lose to. If replica P has not seen the removal, P's
state still lists the tag as a live add; a compacting replica that dropped the
tombstone would RESURRECT the element on the next state merge, diverging from
every replica that kept it. `l <= minAck` rules this out: minAck is the min over
ALL replicas including P, so `l <= minAck <= V[P]` means P HAS seen the removal;
P's live set does not contain the tag. Passing a frontier ahead of a lagging
replica (a V that over-states what everyone has seen) reintroduces exactly this
hazard -- hence the caller contract below.

Note this is about the observable converged VALUE (the projection / `snapshot()`),
which is preserved byte-for-byte. `getState()` MAY legitimately differ after
compaction (fewer tombstones, fewer non-member value registers serialized) -- that
is the point of reclaiming them. Two replicas that converged on the same value
but compacted at different frontiers agree on `snapshot()`, not necessarily on the
tombstone census in `getState()`.

## compact is PURELY LOCAL

`compact(V)` emits NOTHING, introduces no op type, and changes no wire byte. Each
replica independently forgets its own causally-stable tombstones and stable
non-member value registers. There is nothing to broadcast: every peer already saw
the removals the frontier certifies (that is what made them stable), so no peer
needs to be told "I dropped my copy." A replica that never calls `compact` simply
keeps more state; it still converges. A later full-state sync from an uncompacted
peer may re-import some tombstone KEYS (they ride the `removed` array) -- harmless:
they re-tombstone tags already dead everywhere, changing no observable value, and
they carry no lamport so they are stamped fail-closed (below) and can be dropped
again at the next compaction. Reclamation is therefore most effective when peers
compact too or when sync is delta-based (`getStateSince`), but correctness never
depends on coordination.

**Caller contract.** `V` MUST be the pointwise-min version vector across ALL
replicas -- collect each replica's `versionVector()` and take the per-key min. A
frontier ahead of any lagging replica drops a tombstone that replica still needs
and risks resurrection (the failure mode above). A malformed V (not an object, a
non-finite / negative / over-ceiling value) is validated out by `okVector` -- a
sibling of the door's `okState` -- reported to `onError`, and reclaims nothing;
it never throws. Compaction is opt-in and the frontier is the caller's
responsibility, in the same spirit as the C-14 replicaId-uniqueness contract.

## valueReg disposition

decisions/0002 (option A, rejected) established that dropping a value register
UNCONDITIONALLY diverges: a later out-of-order op with a lower `l` would have
nothing to lose to and would win. C4 finally lets the register go, but ONLY under
the stability guarantee C2 named as the seam:

> A `valueReg[id]` entry is dropped iff `id` is a NON-member AND its register
> write is causally stable (`rec.l <= minAck`).

Trace it. `rec.l <= minAck` means every replica has observed this exact register
write. Consider the two ways a future op could reference id:

- A NEW write from any replica: that replica has seen `rec.l` (it is `<= minAck`),
  so its clock is beyond `rec.l` and its new op carries a higher `(l, r)` that
  wins over the register regardless of whether we kept it. Dropping is transparent.
- An OLD competing write `(l' < rec.l)`: it is `< rec.l <= minAck`, hence itself
  stable -- already delivered to every replica and already lost to `rec`. It
  cannot still arrive. (A transport re-delivering it violates the same
  acknowledged-op assumption any tombstone GC rests on.)

The NON-member requirement is the second half: if id were live, `get(id)`,
`values()` and the projection would read `valueReg.get(id).v` -- dropping it would
crash or blank a visible value. A non-member id contributes nothing to the
projection, so forgetting its register changes no observable state. Under
add-wins, a non-member's every tag is tombstoned; a stable register plus
non-membership means both the value and the removal are settled system-wide.

This is the C2-retained register finally released -- exactly at the causal-
stability boundary C2 named, and nowhere earlier.

## The `removed` Set -> Map migration + fail-closed default

`removed` becomes `Map(tagKey -> rmLamport)`:

- `apply`'s `rm` branch stores `removed.set(tagKey, op.l)` -- the removing op's
  lamport is the tombstone's stability key. Last-write-wins on a re-remove is
  fine: every stored value is SOME remover's `l`, and every remover observed the
  tag's add first, so every stored value is above the add lamport.
- `getState()` still emits `[...removed.keys()].sort()` -- the sorted key ARRAY,
  byte-identical to <=1.2.x. No lamport crosses the wire; no new op type.
- Every existing read still works against a Map: `removed.has(tagKey)` (add
  branch, merge prune), `removed.size` (`_retention`), `removed.clear()`
  (`_dispose`).

**Fail-closed default.** A 1.2.x peer's full-state sync sends `removed` as a
lamport-less ARRAY. On absorb, an incoming tag of unknown provenance is stamped
`MAX_LAMPORT - 1` (only if not already present, so a real lamport already learned
is never clobbered). MAX_LAMPORT-1 is effectively never `<= minAck`, so such a
tag is NEVER treated as causally stable and NEVER dropped early. Unknown
provenance is treated as just-seen / not-yet-stable -- fail closed, `null` is not
zero. A tag's true lamport is learned later only from a genuine `rm` op (or a
future C4 peer's richer sync); until then it is conservatively retained.

## Delta sync: getStateSince(V)

`getStateSince(V)` returns the `getState()` shape filtered to entries a peer at V
has NOT seen. The PER-WRITER filters are sound because each entry's writing
replicaId is RECOVERABLE from the entry itself: a LWW register is shipped when
`rec.l > V[rec.r]` (rec.r is the register's writer -- for a tombstone, the
deleter); an OR add tag when its add lamport `l > V[adderR]` (adderR parsed off the
tagKey); an OR value register when `rec.l > V[rec.r]`. Counters ship FULL.

**The OR-Set `removed` tombstone set is shipped IN FULL -- every tombstone, never
filtered against V.** This is a correctness requirement, not a missed optimization.
A tombstone's tagKey encodes only the tag's ADD-writer; the REMOVE-writer's
replicaId is NOT recoverable from it, and the tombstone stores only a bare
rmLamport. So a single peer's vector V cannot certify the peer has seen the
removal: V could be caught up on the add-writer (any per-writer or global-min
comparison passes) while the peer has NEVER heard of the remove-writer at all
(`V[removeWriter]` absent = 0). A minAck-filtered `removed` would then drop a
tombstone the peer genuinely lacks, and `peerAtV.mergeState(delta)` would
RESURRECT the element -- a silent S1 divergence with no onError. (This was the
reviewer-reproduced bug: Y adds tag Y#0, Z removes it at lamport 2; a peer P
caught up on Y at lamport 2 but unaware of Z has `V={Y:2}`, and the old
`rmLamport > minAck` test dropped the tombstone since `2 > 2` is false.) The
global-min `minAck` frontier is valid ONLY for `compact()`, where V is the
pointwise-min across ALL replicas so every writer -- including every remover -- is
covered; it is meaningless for a per-peer delta. Shipping extra tombstones a peer
already effectively holds is idempotent and harmless in the union merge; omitting
a needed one is fatal. So `getStateSince` emits `removed` exactly as `getState()`
does.

The result is a valid PARTIAL state the SAME `mergeState` door validates exactly
like a full one -- so `peerAtV.mergeState(sender.getStateSince(peerAtV.
versionVector()))` converges the peer in one delta frame instead of a full dump,
even under ASYMMETRIC per-writer lag (a peer that heard from a random subset of
writers entirely). `mergeState(getStateSince(V))` on a replica already at V leaves
`getState()` unchanged (the t16 round-trip proof, including empty V = full state
and a V ahead of the doc): the extra tombstones union idempotently. A malformed V
fails closed to a FULL `getState()` (a superset is always safe to send) and is
reported.

## V is untrusted: read ONCE into a validated snapshot (the C-18 discipline)

`compact(V)` and `getStateSince(V)` take an untrusted version vector -- it may
have arrived off the wire for a delta request. It is subject to the SAME TOCTOU
hazard decisions/0001 (C-11 / C-18) closes for every op and state payload: a
live-accessor V (a getter or a Proxy) can return a benign value to a validator and
a different, never-validated value to the code that actually uses it.

The first C4 cut opened exactly that hole: `okVector(V)` validated V in one
`for..in` traversal, and `minAckOf(V)` then RE-READ the same live V in a second,
independent traversal. QA reproduced the divergence: a getter on key `W` returning
`1` on the first read (validated as a correct, non-overstated pointwise-min for a
tombstone at `l=2`) and `1000` on the second read that `minAckOf` computes from ->
`minAck=1000` -> the `l=2` tombstone is reclaimed -> a later correctly-losing op
(`l=1`) resurrects the key. Measured `reclaimed=1, resurrected=true`; the identical
history with a static `{W:1}` gives `reclaimed=0, resurrected=false`. This is NOT
the case-(b) caller misuse above -- the value that was validated was a correct
frontier; the library re-read it after validating.

The fix mirrors the op/state door exactly: `snapshotVector(V)` reads each field of
V EXACTLY ONCE, validates it inline (finite, `>= 0`, `< MAX_LAMPORT`; reject a
`__proto__` key, an array, or a non-object -- fail closed to `null`), and copies it
into a prototype-free snapshot. `compact` and `getStateSince` then consult ONLY
that snapshot -- `minAckOf`, and every per-record `V[rec.r]` / `V[adderR]` filter --
so the value validated is exactly the value used. No live accessor can return a
different value at use, and the delta cannot be made internally inconsistent across
records. Cold path: the snapshot allocation is fine; the `applyOp`/`tick` hot path
and the vv `observe` are untouched. This closes the TOCTOU a live-accessor V would
otherwise open, and `test/17-c4-qa-boundary.test.mjs` pins it as a permanent
regression (the live-accessor V is read exactly once).

## Consequences

- The version-vector max-update is the only new per-op work: O(1),
  zero-allocation, in place (T6 gate holds on set/upd/cinc).
- `compact` / `getStateSince` / `versionVector` are COLD -- reached from an
  explicit app call or a sync round, never from apply/emit/add/rm/tick.
- Wire format unchanged: `removed` still an array, no new op type, a 1.3.0 replica
  and a 1.2.x replica converge over plain ops and full-state sync. Compaction is
  additive; a 1.2.x peer simply never compacts.
- Convergence math is unchanged. Compaction reclaims only causally-stable state,
  proven byte-identical to an uncompacted control by the t5 fuzz and t16 tests.
- Retention is now bounded by LIVE ids after `compact(vv)` under churn (t7), where
  before it grew O(distinct ids seen). The header's "tombstones and removed-tags
  accumulate" note is retired.
