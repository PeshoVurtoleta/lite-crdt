# 0003 -- undo semantics + replica identity

Status: **accepted** (implemented in v1.2.1 / session C3)
Findings: C-13 (undo of an OR-Set removal re-times element order), C-14 (replica
uniqueness + monotonic-lamport assumption behind the total order)
Related: C0 (v1.1.1), C1 (v1.1.2, the remote-op door, decisions/0001) and C2
(v1.2.0, retention + prototype-safe names, decisions/0002) are untouched. The
convergence algebra does NOT change in C3. Both findings are S3 *contract*
findings: C-13 is a written contract over already-correct behaviour, C-14 widens
one cold helper (`genReplicaId`) and records the assumption the ordering rests on.

## C-13: undo restores membership + value, NOT list position

`add(1), add(2), deleteById(1), undo()` yields `[{id:2},{id:1}]`, not
`[{id:1},{id:2}]`. Undo re-adds id `1` with a FRESH tag, so its order key
(`lamport, replicaId`) is newer than id `2`'s and it sorts last. Membership
`{1,2}` and the value register are restored; the list POSITION is not. The bench
convergence fuzzer's own reference oracle already tolerates this ("undo re-add
legitimately re-times element order"). The question S3 raises is not "is this a
bug" but "is this the CONTRACT" -- and it must be written down so a later change
to undo ordering is a deliberate, test-breaking act rather than an accident.

### Options considered

- **(a) Undo restores membership + value, not position.** Undo is modelled as
  what it already is: a fresh LOCAL `add` op. It mints a new tag and a new order
  key, appends at the re-timed position, and -- because it is a real op -- emits
  so every peer converges on the re-add.
- **(b) Undo restores position too: capture the removed element's verbatim tags
  at delete time and re-add them unchanged on undo.** Superficially "more
  faithful" -- the element would reappear at its old index.

### Why (b) is not merely more expensive but UNSOUND

Option (b) cannot work under the existing add-wins / observed-remove tombstone
model. When an element is deleted, its tags are moved into the `removed`
tombstone set. On `apply` of an `add`, `CRDT.js`:

```
433        if (op.t === "add") {
434            const tagKey = op.r + "#" + op.n;
435            if (!removed.has(tagKey)) {
436                let tags = adds.get(id);
...
```

Line 435 -- `if (!removed.has(tagKey))` -- DISCARDS a verbatim re-added tag: a
tag that has already been observed-removed can never be resurrected by re-adding
it, because that is exactly the observed-remove guarantee (an add the network
reorders after its own delete must not un-delete the element). So to make (b)
restore the old index, undo would have to UN-tombstone the tag -- delete it from
`removed` and re-insert it into `adds`. But any peer that already saw the delete
still holds that tag in ITS `removed` set. That peer's `apply` of the resurrected
add hits line 435 and drops it. The undoing replica now believes the element is
live under the old tag; the peer believes it is dead. They diverge PERMANENTLY,
and no later op reconciles them -- there is no timestamp that lets a tombstoned
tag lose to anything. (b) trades a cosmetic index for a hard divergence.

### Decision

**(a).** Undo of an OR-Set removal restores MEMBERSHIP and VALUE, not list
position. Undo is itself a local edit that emits a fresh `add` op; the fresh tag
and new order key are the correct, convergent behaviour, not a defect. `runInverse`
already drives the public `col.add(desc.value)` mutator, so the inverse op is an
ordinary add that peers converge on -- no special-case code, no new bytes on any
hot path. (a) is both the cheaper and the ONLY sound option under add-wins.

This is a pure contract: no code changes for C-13. `test/regressions.test.mjs`
(C-13) PINS the re-timed order `[{id:2},{id:1}]` so a future change to undo
ordering breaks a test rather than silently altering the contract.

## C-14: the total order assumes replica uniqueness + monotonic lamport

Every conflict in the library resolves by the `(lamport, replicaId)` total order
(`tsWins`, `cmpOK`). That order is TOTAL and DETERMINISTIC only under two
assumptions the caller must not violate:

1. **`replicaId` is globally unique per logical replica.** Two distinct replicas
   sharing an id can stamp two different writes with the SAME `(lamport,
   replicaId)` pair. `tsWins` returns `false` for equal pairs (it treats them as
   "the same write"), so the two conflicting writes do not resolve -- each
   replica keeps whichever it applied last, and they diverge with no error. The
   OR-Set is worse: a tag is `replicaId + "#" + n`, so a shared id + a colliding
   local counter `n` produces the SAME tagKey for two genuinely different adds,
   silently merging two elements into one membership tag.
2. **`lamport` is monotonic per replica.** The clock only ever advances (local
   edits `tick`, remote ops merge-then-advance). A caller who resets `clock`
   downward, or supplies a non-monotonic `clock`, can mint a lower-`l` write that
   loses to a stale value it should beat. The door already fails closed on a
   non-finite or ceiling `l` (C-01, C-07); monotonicity WITHIN the finite range
   is the caller's contract.

### genReplicaId widening + fail-closed

Before C3 the auto-generated id was `"r-" + crypto.randomUUID().slice(0, 8)`
(32 bits of entropy) with a `"r-" + Math.random().toString(36).slice(2, 10)`
fallback (weak, ~40 bits, and `Math.random` is not required to be
cryptographically strong or even well-distributed across realms). 32 bits
collides with ~50% probability at only ~77k ids (birthday bound), which is well
within reach of a large fan-out session -- a real uniqueness hazard behind
assumption (1).

After C3 the crypto source (`CRYPTO`) is resolved ONCE at module load in this
order, so `genReplicaId` stays a synchronous read:

1. **Web Crypto global** (`globalThis.crypto` with `randomUUID`) -- present
   unflagged in every browser and in **Node >= 19**.
2. **`node:crypto` `webcrypto` builtin** -- the fallback for **Node 18.x LTS**.
   Node 18's default runtime does NOT expose the unflagged `globalThis.crypto`
   (the unflagged global landed in Node 19.0.0), so without this branch every
   auto-minted id on a supported Node 18 default runtime would throw. Resolved
   via a `try { await import("node:crypto") }` guarded by a
   `process.versions.node` check; a browser has no `node:crypto`, its dynamic
   import rejects, and the `catch` leaves the Web Crypto global from step 1 in
   place. `node:crypto` is a Node builtin, not a runtime dependency, so the
   zero-deps law holds. `webcrypto` exposes both `randomUUID` and
   `getRandomValues`.

From that single `CRYPTO`, `genReplicaId` produces:

- **Primary:** `CRYPTO.randomUUID()` with dashes stripped -- 122 bits of
  entropy, a 32-hex-char body, `"r-"` prefix -> a **34-char** id.
- **Fallback (no `randomUUID`):** `CRYPTO.getRandomValues(new Uint8Array(16))`
  hex-encoded -- 128 bits, also a 34-char id.
- **No crypto source at all** (neither the Web Crypto global NOR `node:crypto`):
  `throw new CRDTError("misconfigured", ...)`. The `Math.random` path is DELETED.
  Failing closed is mandatory: a silently weak id violates assumption (1)
  invisibly, which is the exact class of bug the door philosophy (fail closed,
  null is not zero) forbids. A caller in such a realm must supply an explicit
  `replicaId`.

Because every supported Node has `node:crypto` and every browser has the Web
Crypto global, the throw is a genuine last resort -- it fires only in an exotic,
crypto-less realm, not on any supported target. It exists to fail loud, not to
fire in practice.

### Computed collision probability

Birthday approximation `p ~= 1 - exp(-k^2 / (2N))`:

| entropy | N          | k = 1e6 ids       | k for p = 1e-9 |
| ------- | ---------- | ----------------- | -------------- |
| 32-bit (old primary) | 2^32  | p ~= 1 (certain)  | ~2.9          |
| 122-bit (new primary) | 2^122 | ~9.4e-26         | ~1.0e14       |
| 128-bit (fallback)    | 2^128 | ~1.5e-27         | ~8.2e14       |

At 1e6 auto-minted ids the 122-bit primary has a collision probability of order
1e-25 -- for practical purposes, zero. `test/14-identity.test.mjs` (C-14) mints
1e5 ids and asserts `new Set(ids).size === 1e5` (no collision) and that every id
is exactly 34 chars. The fail-closed throw is COVERED BY INSPECTION, not a stub:
once `CRYPTO` is resolved from `node:crypto` at module load, removing
`globalThis.crypto` in-process no longer reaches the throw (the module-scope
`CRYPTO` is already bound), and defeating the `node:crypto` import after load is
impractical -- so the throw path is verified by reading the code, while the test
asserts the primary + `getRandomValues`-fallback + uniqueness paths live.

## Consequences

- `genReplicaId` is COLD: reached once from `createCRDTDoc`, never from
  `applyOp`/emit/`add`/`rm`/`upd`/`cinc` or any loop. The wider id therefore adds
  no per-op allocation; the T6 zero-alloc gate on set/upd/cinc is unaffected
  (all its docs use caller-supplied ids anyway).
- The id is longer, so every OR-Set `tagKey` (`replicaId + "#" + n`) minted by an
  auto-id doc is ~24 bytes wider. This is a live-memory cost proportional to the
  tag count, NOT a hot-path allocation. The T7 retention bound is
  width-independent -- `_retention().adds` stays O(live ids) regardless of id
  length -- and is re-exercised in `t7-soak.mjs` with an auto-generated id.
- **Wire format unchanged.** `replicaId` is opaque to the wire: ops and state
  serialize the id as an ordinary string. A 34-char id round-trips exactly like
  an 8-char one; existing peers and persisted state stay byte-compatible.
- Convergence math is unchanged. C-13 changes no code; C-14 changes only the
  id-minting helper, not any op or merge.
