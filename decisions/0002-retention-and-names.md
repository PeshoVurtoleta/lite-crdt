# 0002 -- OR-Set retention + prototype-safe names/ids

Status: **accepted** (implemented in v1.2.0 / session C2)
Findings: C-10 (retention), C-12 (prototype-safe names/ids)
Related: C-11 (deterministic snapshot/getState) shipped in the same session; it
needs no policy decision (it is a pure "sort the cold output" fix), so it is
recorded in the CHANGELOG, not here.

## Context

C2 is three orthogonal hygiene fixes on the OR-Set and the document's cold
serialization surface. The convergence algebra does NOT change; C0 (v1.1.1) and
C1 (v1.1.2, the remote-op validation door) are untouched. Two of the three fixes
carry a real decision with a WHY that must not be re-litigated later.

## C-10: keep `valueReg`, drop the emptied `adds` entry

An OR-Set member id carries two pieces of state:

- `adds`: `id -> Map(tagKey -> lamport)` -- the live observed-remove membership
  tags. Membership is add-wins: an id is a member iff it has at least one live tag.
- `valueReg`: `id -> { l, r, v }` -- the last-write-wins value register, keyed by
  the `(lamport, replicaId)` total order.

When an id's last live tag is removed, its `adds` entry becomes an empty `Map`.
Before C2 that empty entry was retained forever, so `adds` grew O(ops) under an
add/delete churn instead of O(live ids).

### Options considered

- **A. Drop both `adds` and `valueReg` when the id leaves the set.** Maximally
  frees memory, but it is WRONG. `add` always calls `setValue`, so the value
  register exists; but it also carries the id's max-lamport timestamp. Drop it,
  and a later op that arrives out of order with a *lower* `l` -- a re-add or an
  `upd` the transport delayed -- has nothing to lose to, so it wins and the
  replicas diverge. This is exactly the reorder/redeliver freedom the whole
  package promises to tolerate. Rejected.
- **B. Keep both.** No divergence, but `adds` retains a dead empty `Map` per
  churned id: O(ops) retention, the leak C-10 names.
- **C. Keep `valueReg`, drop the emptied `adds` entry.** Correct AND bounded.

### Decision

**C.** The value register is KEPT (convergence needs its timestamp to persist so a
late lower-`l` op cannot win). The emptied `adds` entry is DROPPED the moment
`tags.size === 0`, in every place an id can lose its last tag:

- `apply`'s `rm` branch -- AFTER `recomputeOK(id)` and `reconcile(...)`, both of
  which read the id's order key. The delete must not run before those reads, or an
  id's membership would outlive the key a reconcile still needs. `valueReg` is
  untouched.
- `_mergeState`'s prune loop -- a merge that tombstones an id's every tag, or a
  union that created a tag `Map` for an id whose incoming tags were all already
  tombstoned, must not leave the empty `Map` behind.
- `_mergeState`'s live-add-id-without-value-register consistency check -- the
  whole `adds` entry is dropped (not merely cleared), so no empty `Map` survives.

Retention is now O(live ids), not O(ops). `getState()` already filtered empty tag
Maps, so the fix changes no serialized output and no convergence result; it is a
pure in-memory retention win. A test-only `_retention()` probe exposes the live
`adds`/`valueReg` cardinalities that `getState()` hides, so the win is provable.

### Seam for C4 (tombstone GC)

Keeping `valueReg` (and the `removed` tombstone set) is what still makes retention
O(distinct ids seen), not O(live ids), across a doc's lifetime. Letting the value
register and tombstones go requires knowing an op can no longer arrive out of
order -- a version-vector / causal-stability check. That check is the seam C4
(tombstone GC) widens; it is deliberately out of scope for C2. Until then the
header's "tombstones and removed-tags accumulate" note stands.

## C-12: `Object.create(null)` over a guard-throw for `__proto__` names/ids

A collection name or an OR-Set element id is caller-supplied data. When
`getState()`/`snapshot()` build their output objects with a plain `{}`, assigning
`out["__proto__"] = value` retargets the object's prototype instead of creating an
own key -- so a `__proto__` collection name or element id is silently lost, and a
crafted payload can reach a prototype through the same door.

### Options considered

- **A. Throw on a `__proto__` name/id.** Consistent with the LWW-Map *key* guard
  (a map key `__proto__` throws locally). But a collection name and an OR-Set
  element id are broader than a map key -- an id can legitimately be any string --
  and adding a throw on the cold serialization path is a new failure surface that
  contradicts the door's reject-and-continue posture.
- **B. Build the output over `Object.create(null)`.** A `__proto__` name/id
  becomes an ordinary OWN key: it round-trips through `getState -> mergeState`
  intact, `for..in` and `Object.hasOwn` see it, and there is no prototype to
  retarget -- so the crafted-`__proto__` hazard is removed WITHOUT a new throw.

### Decision

**B, applied uniformly.** The invariant is stated plainly:

> Every `getState()` output object that is keyed by caller-supplied data is built
> over `Object.create(null)`.

That is: the OR-Set `getState()` `adds`/`values` objects (and each inner tag Map
object); the PN-Counter `getState()` `p`/`n` objects (keyed by replicaId); the
LWW-Map `getState()` `entries` object; and the document's `getState()` and
`snapshot()` top-level `cols`/`out` objects. All four serializers follow ONE rule,
not three. A `__proto__` collection name, element id, or replicaId all become own
keys that round-trip, and the throw surface stays exactly where the door already
put it -- nowhere new.

The counter axis is the one that bites: a `__proto__` replicaId reaches `P`/`N`
both remotely (`okOp` accepts `r="__proto__"` -- a non-empty string) and locally
(a doc replicaId is unvalidated). On a plain `{}` serializer, `p["__proto__"] =
<number>` hits the `__proto__` setter, which silently drops a non-object value, so
the cumulative vanishes from serialized state and the peer diverges with zero
`onError`. The map axis cannot currently be reached (a `__proto__` map *key* is
guarded at the door and dropped in `apply`), but it is built the same way so the
invariant holds by construction rather than by a guard that a later refactor could
move. The LWW-Map *key* guard itself is unchanged: a map key `__proto__` still
cannot be stored, because that is a distinct, already-decided case.

## Consequences

- Convergence math is unchanged; existing state and ops stay byte-compatible.
- Retention on the OR-Set live map is O(live ids); tombstones/value-registers
  still accumulate (the C4 seam).
- `getState()`/`snapshot()` are cold (called between phases, never on the
  apply/emit/rm hot loop), so the C-11 name sort and these `Object.create(null)`
  allocations do not touch the T6 zero-alloc gate.
